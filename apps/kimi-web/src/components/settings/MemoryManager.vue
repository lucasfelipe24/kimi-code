<!-- apps/kimi-web/src/components/settings/MemoryManager.vue -->
<!-- Persistent-memory manager (the `persistent-memory` experiment, v2 only).
     Lists the durable memories visible to the active workspace and offers
     create / edit / delete. All gating (feature flag, workspace trust, byte
     caps, redaction) lives on the daemon; this panel only surfaces the results
     and maps the known error codes to friendly notices. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../../api';
import { isDaemonApiError } from '../../api/errors';
import type {
  AppMemory,
  AppMemoryScope,
  AppMemoryType,
} from '../../api/types';
import Button from '../ui/Button.vue';
import Select from '../ui/Select.vue';
import Input from '../ui/Input.vue';
import Textarea from '../ui/Textarea.vue';

const { t } = useI18n();

const props = defineProps<{
  /** Active workspace id, or null when none is selected. */
  workspaceId: string | null;
  /** Backend generation — memory is only available on v2 (kap-server). */
  backend: 'v1' | 'v2';
}>();

// Wire error codes (packages/kap-server/src/protocol/error-codes.ts).
const CODE_MEMORY_DISABLED = 40924;
const CODE_MEMORY_TRUST_REQUIRED = 40922;

const SCOPES: AppMemoryScope[] = ['user', 'workspace', 'project'];
const TYPES: AppMemoryType[] = ['user', 'feedback', 'project', 'reference'];

const items = ref<AppMemory[]>([]);
const loading = ref(false);
const saving = ref(false);
/** Distinguishes "flag off" from a generic load error, for the empty state. */
const errorKind = ref<'none' | 'disabled' | 'generic'>('none');
const notice = ref<string | null>(null);

// Edit form: `null` = closed, `{ id: null }` = create, `{ id }` = edit.
interface FormState {
  id: string | null;
  scope: AppMemoryScope;
  type: AppMemoryType;
  name: string;
  description: string;
  body: string;
}
const form = ref<FormState | null>(null);

const available = computed(() => props.backend === 'v2');

const sortedItems = computed(() =>
  [...items.value].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
);

function scopeLabel(scope: AppMemoryScope): string {
  return t(`memory.scopes.${scope}`);
}

function typeLabel(type: AppMemoryType): string {
  return t(`memory.types.${type}`);
}

async function load(): Promise<void> {
  errorKind.value = 'none';
  notice.value = null;
  if (!available.value || props.workspaceId === null) {
    items.value = [];
    return;
  }
  loading.value = true;
  try {
    items.value = await getKimiWebApi().listMemories(props.workspaceId);
  } catch (err) {
    items.value = [];
    errorKind.value = isDaemonApiError(err) && err.code === CODE_MEMORY_DISABLED ? 'disabled' : 'generic';
    if (errorKind.value === 'generic') notice.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

function errorMessage(err: unknown): string {
  if (isDaemonApiError(err)) {
    if (err.code === CODE_MEMORY_DISABLED) return t('memory.errors.disabled');
    if (err.code === CODE_MEMORY_TRUST_REQUIRED) return t('memory.errors.trustRequired');
    return err.message;
  }
  return t('memory.errors.generic');
}

function openCreate(): void {
  notice.value = null;
  form.value = {
    id: null,
    scope: 'workspace',
    type: 'project',
    name: '',
    description: '',
    body: '',
  };
}

function openEdit(memory: AppMemory): void {
  notice.value = null;
  form.value = {
    id: memory.id,
    scope: memory.scope,
    type: memory.type,
    name: memory.name,
    description: memory.description,
    body: memory.body,
  };
}

function closeForm(): void {
  form.value = null;
}

const formValid = computed(() => {
  const f = form.value;
  return f !== null && f.name.trim() !== '' && f.description.trim() !== '' && f.body.trim() !== '';
});

async function submitForm(): Promise<void> {
  const f = form.value;
  if (f === null || props.workspaceId === null || !formValid.value) return;
  saving.value = true;
  notice.value = null;
  try {
    if (f.id === null) {
      await getKimiWebApi().createMemory(props.workspaceId, {
        scope: f.scope,
        type: f.type,
        name: f.name.trim(),
        description: f.description.trim(),
        body: f.body.trim(),
      });
    } else {
      await getKimiWebApi().updateMemory(props.workspaceId, f.id, {
        scope: f.scope,
        type: f.type,
        name: f.name.trim(),
        description: f.description.trim(),
        body: f.body.trim(),
      });
    }
    closeForm();
    await load();
  } catch (err) {
    notice.value = errorMessage(err);
  } finally {
    saving.value = false;
  }
}

async function remove(memory: AppMemory): Promise<void> {
  if (props.workspaceId === null) return;
  // eslint-disable-next-line no-alert
  if (!window.confirm(t('memory.confirmForget', { name: memory.name }))) return;
  saving.value = true;
  notice.value = null;
  try {
    await getKimiWebApi().forgetMemory(props.workspaceId, memory.scope, memory.id);
    await load();
  } catch (err) {
    notice.value = errorMessage(err);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
watch(() => [props.workspaceId, props.backend], load);
</script>

<template>
  <section class="panel">
    <section class="sec">
      <div class="sec-head">
        <h3 class="sec-title">{{ t('memory.title') }}</h3>
        <Button
          v-if="available && workspaceId !== null && errorKind !== 'disabled'"
          variant="primary"
          size="sm"
          :disabled="saving"
          @click="openCreate"
        >
          {{ t('memory.add') }}
        </Button>
      </div>
      <p class="sec-desc">{{ t('memory.description') }}</p>

      <!-- Unavailable / empty states -->
      <div v-if="!available" class="empty">{{ t('memory.unavailable') }}</div>
      <div v-else-if="workspaceId === null" class="empty">{{ t('memory.noWorkspace') }}</div>
      <div v-else-if="errorKind === 'disabled'" class="empty">{{ t('memory.errors.disabled') }}</div>
      <div v-else-if="loading" class="empty">{{ t('memory.loading') }}</div>
      <div v-else-if="sortedItems.length === 0 && form === null" class="empty">
        {{ t('memory.empty') }}
      </div>

      <p v-if="notice" class="notice" role="alert">{{ notice }}</p>

      <!-- Create / edit form -->
      <div v-if="form !== null" class="form">
        <h4 class="form-title">{{ form.id === null ? t('memory.add') : t('memory.edit') }}</h4>
        <div class="frow">
          <label class="flabel">{{ t('memory.fields.scope') }}</label>
          <Select v-model="form.scope" :aria-label="t('memory.fields.scope')">
            <option v-for="s in SCOPES" :key="s" :value="s">{{ scopeLabel(s) }}</option>
          </Select>
        </div>
        <div class="frow">
          <label class="flabel">{{ t('memory.fields.type') }}</label>
          <Select v-model="form.type" :aria-label="t('memory.fields.type')">
            <option v-for="ty in TYPES" :key="ty" :value="ty">{{ typeLabel(ty) }}</option>
          </Select>
        </div>
        <div class="frow">
          <label class="flabel">{{ t('memory.fields.name') }}</label>
          <Input v-model="form.name" :placeholder="t('memory.fields.namePlaceholder')" />
        </div>
        <div class="frow">
          <label class="flabel">{{ t('memory.fields.descriptionField') }}</label>
          <Input
            v-model="form.description"
            :placeholder="t('memory.fields.descriptionPlaceholder')"
          />
        </div>
        <div class="frow">
          <label class="flabel">{{ t('memory.fields.body') }}</label>
          <Textarea v-model="form.body" :rows="4" :placeholder="t('memory.fields.bodyPlaceholder')" />
        </div>
        <div class="form-actions">
          <Button variant="ghost" size="sm" :disabled="saving" @click="closeForm">
            {{ t('memory.cancel') }}
          </Button>
          <Button variant="primary" size="sm" :disabled="!formValid || saving" @click="submitForm">
            {{ t('memory.save') }}
          </Button>
        </div>
      </div>

      <!-- List -->
      <ul v-if="available && workspaceId !== null && sortedItems.length > 0" class="mlist">
        <li v-for="m in sortedItems" :key="`${m.scope}:${m.id}`" class="mitem">
          <div class="mhead">
            <span class="mname">{{ m.name }}</span>
            <span class="mbadges">
              <span class="badge">{{ scopeLabel(m.origin) }}</span>
              <span class="badge badge-type">{{ typeLabel(m.type) }}</span>
            </span>
          </div>
          <p class="mdesc">{{ m.description }}</p>
          <pre class="mbody">{{ m.body }}</pre>
          <div class="mactions">
            <Button variant="ghost" size="sm" :disabled="saving" @click="openEdit(m)">
              {{ t('memory.editAction') }}
            </Button>
            <Button variant="danger-soft" size="sm" :disabled="saving" @click="remove(m)">
              {{ t('memory.forget') }}
            </Button>
          </div>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.sec-desc {
  color: var(--color-text-muted);
  font-size: 0.85rem;
  margin: 0.25rem 0 0.75rem;
}
.empty {
  color: var(--color-text-muted);
  padding: 0.75rem 0;
  font-size: 0.9rem;
}
.notice {
  color: var(--color-danger);
  font-size: 0.85rem;
  margin: 0.5rem 0;
}
.form {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0.75rem;
  margin-bottom: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.form-title {
  margin: 0;
  font-size: 0.95rem;
}
.frow {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.flabel {
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.mlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.mitem {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
}
.mhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.mname {
  font-weight: 600;
}
.mbadges {
  display: flex;
  gap: 0.35rem;
}
.badge {
  font-size: 0.72rem;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  background: var(--color-surface-2, rgba(127, 127, 127, 0.15));
  color: var(--color-text-muted);
}
.badge-type {
  text-transform: capitalize;
}
.mdesc {
  margin: 0.35rem 0;
  font-size: 0.85rem;
  color: var(--color-text-muted);
}
.mbody {
  margin: 0 0 0.5rem;
  padding: 0.4rem 0.5rem;
  background: var(--color-surface-2, rgba(127, 127, 127, 0.08));
  border-radius: 6px;
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 8rem;
  overflow: auto;
}
.mactions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
