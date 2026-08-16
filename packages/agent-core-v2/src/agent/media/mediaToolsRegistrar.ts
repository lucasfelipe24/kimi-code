/**
 * Media tool production registration — the Agent-scope service that keeps
 * `ReadMediaFile` in the tool registry in sync with the bound model.
 *
 * Media tools cannot ride the module-level `registerAgentToolService(...)`
 * contribution table: its activation runs when the Agent is created, and at
 * that point no model is bound yet — the capabilities are still
 * `UNKNOWN_CAPABILITY`, so a capability gate would permanently skip the
 * tool. Registration instead re-runs whenever the resolved model changes:
 * every profile/model update publishes `agent.status.updated`, and this
 * service re-invokes {@link registerMediaTools} when the model alias or its
 * media capabilities differ from what it last registered (rebinding the
 * video uploader to the new model, and dropping the tool when the model
 * loses media input). The `inlineVideoSupported` flag rides the same
 * refresh: it is derived from the model's protocol because only the OpenAI
 * family drops inline video on the wire — every other protocol that
 * converts `video_url` takes the inline fallback when no upload hook
 * exists.
 *
 * The plain-data state (`registeredKey`) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it; `registration` stays an
 * instance field (the live `IDisposable` tool-registration handle, not plain
 * data).
 *
 * Visual-companion binding: when `[visual_model]` is configured and the bound
 * caller model is text-only (no `image_in` / `video_in`), the tool is
 * registered against the visual model's capabilities and requester instead, so
 * `ReadMediaFile` stays available and delegates inspection to the visual model
 * (returning text to the caller). A vision-capable caller always wins; a
 * dangling visual pointer falls back to the caller model with a logged warning
 * (the Session-scope validation backstop surfaces the config error at session
 * creation). The registration key includes the visual alias and its capability
 * signature, so a `[visual_model]` change re-runs registration via the config
 * change subscription.
 *
 * Agent scope creation instantiates this service before any `opts.binding`
 * bind runs, so the first `agent.status.updated` is always observed.
 */

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentStateService } from '#/agent/state/agentState';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { type ModelRequester } from '#/kosong/model/modelRequester';
import { ILogService } from '#/_base/log/log';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { VISUAL_MODEL_SECTION, resolveVisualModel } from '#/session/visual/configSection';
import { extendWorkspaceWithSkillRoots } from '#/tool/path-access';

import { IAgentMediaToolsRegistrar } from './mediaTools';
import { createVideoUploader, registerMediaTools } from './registerMediaTools';
import { createVisualInspector } from './visualInspection';

export const mediaRegisteredKeyKey = defineState<string | undefined>(
  'media.registeredKey',
  () => undefined as string | undefined,
);

export class AgentMediaToolsRegistrar extends Service implements IAgentMediaToolsRegistrar {
  declare readonly _serviceBrand: undefined;

  private registration: IDisposable | undefined;

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IEventBus eventBus: IEventBus,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IConfigService private readonly appConfig: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {
    super();
    this.states.register(mediaRegisteredKeyKey);
    this.refresh();
    this._register(eventBus.subscribe('agent.status.updated', () =>{  this.refresh(); }));
    this._register(
      this.appConfig.onDidSectionChange((e) => {
        if (e.domain === VISUAL_MODEL_SECTION) this.refresh();
      }),
    );
    this._register(toDisposable(() => this.registration?.dispose()));
  }

  private get registeredKey(): string | undefined {
    return this.states.get(mediaRegisteredKeyKey);
  }

  private set registeredKey(value: string | undefined) {
    this.states.set(mediaRegisteredKeyKey, value);
  }

  private refresh(): void {
    const capabilities = this.profile.getModelCapabilities();
    const modelAlias = this.profile.getModel();
    const visualRecipe = resolveVisualModel(this.appConfig, this.flags);
    const visualAlias = visualRecipe?.model;
    let visualRequester: ModelRequester | undefined;
    let visualModel: Model | undefined;
    if (modelAlias !== '' && visualAlias !== undefined) {
      try {
        visualRequester = this.modelCatalog.getRequester(visualAlias);
        visualModel = visualRequester.model;
      } catch (error) {
        this.log.warn(
          'Configured visual model could not be resolved; media tools fall back to the caller model',
          {
            model: visualAlias,
            ...(error instanceof Error ? { error: error.message } : {}),
          },
        );
      }
    }
    const visualCapabilities = visualModel?.capabilities;
    const useVisual =
      visualRequester !== undefined &&
      !capabilities.image_in &&
      !capabilities.video_in &&
      (visualCapabilities?.image_in === true || visualCapabilities?.video_in === true);
    const key = [
      modelAlias,
      String(capabilities.image_in),
      String(capabilities.video_in),
      useVisual ? String(visualAlias) : '',
      useVisual ? String(visualCapabilities?.image_in) : '',
      useVisual ? String(visualCapabilities?.video_in) : '',
    ].join('|');
    if (key === this.registeredKey) return;
    this.registeredKey = key;
    this.registration?.dispose();
    const workspaceCtx = this.workspaceCtx;
    const skillCatalog = this.skillCatalog;
    const env = this.env;
    let requester: ModelRequester | undefined;
    let model: Model | undefined;
    if (modelAlias !== '') {
      requester = this.modelCatalog.getRequester(modelAlias);
      model = requester.model;
    }
    const boundRequester = useVisual ? visualRequester : requester;
    const boundModel = useVisual ? visualModel : model;
    const boundModelAlias = useVisual ? String(visualAlias) : modelAlias;
    this.registration = registerMediaTools(this.toolRegistry, {
      fs: this.fs,
      env: this.env,
      workspace: {
        get workspaceDir() {
          return workspaceCtx.workDir;
        },
        get additionalDirs() {
          return extendWorkspaceWithSkillRoots(
            { workspaceDir: workspaceCtx.workDir, additionalDirs: workspaceCtx.additionalDirs },
            skillCatalog?.catalog.getSkillRoots() ?? [],
            env.pathClass,
          ).additionalDirs;
        },
      },
      capabilities: useVisual ? visualCapabilities : capabilities,
      videoUploader: createVideoUploader(boundRequester, {
        client: this.telemetry,
        props: {
          model: boundModelAlias,
          provider_type: boundModel?.providerType ?? boundModel?.protocol,
          protocol: boundModel?.protocol,
        },
      }),
      inlineVideoSupported:
        boundModel?.protocol !== 'openai' && boundModel?.protocol !== 'openai_responses',
      telemetry: this.telemetry,
      visualInspector:
        useVisual && modelAlias !== ''
          ? createVisualInspector({
              config: this.appConfig,
              flags: this.flags,
              modelCatalog: this.modelCatalog,
              callerModelAlias: modelAlias,
              callerThinkingLevel: this.profile.getEffectiveThinkingLevel(),
            })
          : undefined,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMediaToolsRegistrar,
  AgentMediaToolsRegistrar,
  ScopeActivation.OnScopeCreated,
  'media',
);
