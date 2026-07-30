#!/usr/bin/env python3
"""musepool 网关工具 —— 通过 agent_gw SDK 调 musepool_recall / musepool_fetch。

CLI(SKILL 里不出现 JSON):

  python3 muse_tool.py ensure-deps
  python3 muse_tool.py recall --axis 'gist=6@0.7:"..."' --axis 'color=4@0.5:"..."' \
                              [--temp 0.3] [--seed 42]
  python3 muse_tool.py fetch  --ids a,b --fields seed,reference --ref-dim color,motion
  python3 muse_tool.py fetch  --query "..." --count 2 --fields seed,reference --ref-dim algorithms,imagery

依赖:首次使用前跑 ensure-deps——检查 agent-gw >= 0.2.6 和 PyYAML,缺了才装
(与 video_generation 的 ensure-deps 同款;运行时不再隐式安装)。
鉴权:脚本不碰凭证也不碰端点(与 video_generation / ifind 一致),全部交给
agent_gw SDK 从运行环境解析——api_key: KIMI_API_KEY 环境变量 / ~/.kimi/agent-gw.json;
base_url: KIMI_BASE_URL / 配置文件 base_url / SDK 默认。两者成对来自同一环境;
本地开发要指非默认网关时,把 base_url 和对应的 api_key 一起写进 ~/.kimi/agent-gw.json,
不要用环境变量只覆盖其中一个(钥匙和锁必须来自同一套)。
输出:musepool 裸 YAML(resp.raw)到 stdout——比 JSON 紧凑、可读、对 LLM 更友好。
"""
from __future__ import annotations
import warnings
warnings.filterwarnings("ignore")

import argparse
import importlib.metadata as metadata
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

AXIS_MAX = 12       # 每轴召回条数硬上限(与网关 pkg/musepool AxisMax 对齐)
FETCH_ID_MAX = 8    # fetch 一次最多 id 数(与网关 FetchIDMax 对齐)
DEFAULT_TIMEOUT = 60.0
AGENT_GW_MANIFEST = "https://cdn.kimi.com/agentgw/pysdk/manifest.json"
MIN_AGENT_GW_VERSION = (0, 2, 6)
MIN_AGENT_GW_VERSION_TEXT = "0.2.6"
# SKILL 的 Setup 步:可读子命令而不是内联一行流。从自身文件名推导,插件改名也不错。
ENSURE_DEPS_COMMAND = f"python3 scripts/{Path(__file__).name} ensure-deps"


# --- dependencies -----------------------------------------------------------


def _version_tuple(version: str) -> Tuple[int, int, int]:
    parts = [int(part) for part in re.findall(r"\d+", version)[:3]]
    parts.extend([0] * (3 - len(parts)))
    return tuple(parts[:3])


def _agent_gw_version() -> Optional[str]:
    for package_name in ("agent-gw", "agent_gw"):
        try:
            return metadata.version(package_name)
        except metadata.PackageNotFoundError:
            continue
    return None


def _ensure_sdk():
    """导入 agent_gw 并校验版本;不满足时提示跑 ensure-deps(运行时不隐式安装)。

    返回 (AgentGwClient, AgentGwError)。
    """
    try:
        from agent_gw import AgentGwClient, AgentGwError
    except ModuleNotFoundError as exc:
        raise SystemExit(
            f"Missing dependency: agent-gw >= {MIN_AGENT_GW_VERSION_TEXT}. "
            f"Install it by running: {ENSURE_DEPS_COMMAND}"
        ) from exc
    version = _agent_gw_version()
    if not version or _version_tuple(version) < MIN_AGENT_GW_VERSION:
        found = version or "unknown"
        raise SystemExit(
            f"agent-gw >= {MIN_AGENT_GW_VERSION_TEXT} is required; found {found}. "
            f"Upgrade it by running: {ENSURE_DEPS_COMMAND}"
        )
    return AgentGwClient, AgentGwError


def _ensure_yaml():
    """导入 PyYAML 并返回 (yaml 模块, 自定义 Dumper);缺失时提示跑 ensure-deps。

    自定义 Dumper:含换行符的字符串用 block scalar(`|`),可读性最好;
    普通字符串保持一行(`width=4096` 避免 PyYAML 在 80 列处自动折行)。
    """
    try:
        import yaml
    except ModuleNotFoundError as exc:
        raise SystemExit(
            f"Missing dependency: PyYAML. Install it by running: {ENSURE_DEPS_COMMAND}"
        ) from exc

    class _Dumper(yaml.SafeDumper):
        pass

    def _str_representer(dumper, data):
        style = "|" if "\n" in data else None
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)

    _Dumper.add_representer(str, _str_representer)
    return yaml, _Dumper


def _fetch_latest_wheel_url() -> str:
    """从已发布的 CDN manifest 解析最新 agent-gw wheel 地址。"""
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(AGENT_GW_MANIFEST, timeout=15) as r:
            url = json.loads(r.read().decode())["latest"]["url"]
    except Exception as exc:
        raise SystemExit(
            f"failed to fetch the agent-gw manifest from {AGENT_GW_MANIFEST}: {exc}"
        ) from exc
    if not isinstance(url, str) or not url:
        raise SystemExit(f"the agent-gw manifest at {AGENT_GW_MANIFEST} has no latest.url")
    return url


def _pip_install(spec: str, label: str) -> None:
    import subprocess

    proc = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-U", "--user", spec],
        timeout=180,
    )
    if proc.returncode != 0:
        raise SystemExit(f"pip failed to install {label} ({spec})")


def ensure_deps(args: argparse.Namespace) -> int:
    """确保 agent-gw >= MIN_AGENT_GW_VERSION 和 PyYAML 已装;只在需要时安装/升级。

    这是 SKILL 的 Setup 步:检查当前解释器,首次真实调用不因缺依赖或版本过旧而失败。
    """
    installed_anything = False

    version = _agent_gw_version()
    if version and _version_tuple(version) >= MIN_AGENT_GW_VERSION:
        print(f"agent-gw {version} already satisfies >= {MIN_AGENT_GW_VERSION_TEXT}.")
    else:
        if version:
            print(f"agent-gw {version} is older than {MIN_AGENT_GW_VERSION_TEXT}; upgrading...")
        else:
            print(f"agent-gw not found; installing >= {MIN_AGENT_GW_VERSION_TEXT}...")
        _pip_install(_fetch_latest_wheel_url(), "agent-gw")
        installed_anything = True

    try:
        import yaml  # noqa: F401

        print("PyYAML already installed.")
    except ModuleNotFoundError:
        print("PyYAML not found; installing...")
        _pip_install("pyyaml", "PyYAML")
        installed_anything = True

    if installed_anything:
        import importlib

        importlib.invalidate_caches()
        # --user 安装对当前已运行的进程可能不可见;下一条命令是新进程,会正常加载。
        print("Dependencies installed; they will be available to the next command.")
    else:
        print("All dependencies satisfied.")
    return 0


# --- CLI params -------------------------------------------------------------


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def parse_axis(spec: str) -> Optional[Dict[str, Any]]:
    """解析 '<field>=<n>[@temp]:"<query>"'。对齐 curl 版 / 原 muse.mjs parseAxis。"""
    c = spec.find(":")
    if c < 0:
        return None
    head, q = spec[:c].strip(), spec[c + 1:].strip()
    if len(q) >= 2 and q[0] == q[-1] and q[0] in ('"', "'"):
        q = q[1:-1]  # 剥掉 SKILL 里给 query 加的外层引号(写法约定,非内容)
    e = head.find("=")
    if e < 0:
        return None
    field = head[:e].strip().lower()
    npart, temp_v = head[e + 1:].strip(), None
    at = npart.find("@")
    if at >= 0:
        try:
            temp_v = _clamp01(float(npart[at + 1:]))
        except ValueError:
            temp_v = 0.0
        npart = npart[:at].strip()
    try:
        n = max(1, min(AXIS_MAX, int(float(npart))))
    except ValueError:
        n = 1
    ax: Dict[str, Any] = {"field": field, "n": n, "query": q}
    if temp_v is not None:
        ax["temp"] = temp_v
    return ax


def build_recall_params(args: argparse.Namespace) -> Dict[str, Any]:
    axes = [ax for ax in (parse_axis(s) for s in args.axis) if ax]
    if not axes:
        sys.stderr.write('muse_tool: 至少一个 --axis <field>=<n>[@temp]:"<query>"\n')
        sys.exit(2)
    params: Dict[str, Any] = {"axes": axes}
    if args.filter:
        params["filters"] = args.filter
    if args.nots:
        params["nots"] = args.nots
    if args.temp is not None:
        try:
            params["temp"] = _clamp01(float(args.temp))
        except ValueError:
            pass
    if args.seed is not None:
        try:
            params["seed"] = int(args.seed)
        except ValueError:
            pass
    return params


def build_fetch_params(args: argparse.Namespace) -> Dict[str, Any]:
    params: Dict[str, Any] = {}
    if args.ids:
        params["ids"] = [x.strip() for x in args.ids.split(",") if x.strip()][:FETCH_ID_MAX]
    if args.query:
        params["query"] = args.query
    if args.count is not None:
        try:
            params["count"] = int(args.count)
        except ValueError:
            pass
    if args.fields:
        params["fields"] = [x.strip() for x in args.fields.split(",") if x.strip()]
    if args.ref_dim:
        params["ref_dim"] = [x.strip() for x in args.ref_dim.split(",") if x.strip()]
    if "ids" not in params and "query" not in params:
        sys.stderr.write("muse_tool: fetch 需要 --ids 或 --query\n")
        sys.exit(2)
    return params


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="musepool 网关工具(SDK 版)")
    sub = p.add_subparsers(dest="command", required=True)

    e = sub.add_parser(
        "ensure-deps",
        help="Check agent-gw >= 0.2.6 and PyYAML are installed; install/upgrade if needed",
    )

    r = sub.add_parser("recall", help="多轴召回,返回浅摘要")
    r.add_argument("--axis", "--ax", action="append", default=[],
                   metavar='<field>=<n>[@temp]:"<query>"', help="可重复,每轴独立")
    r.add_argument("--filter", action="append", default=[], help="novelty>0.7 / modality=web")
    r.add_argument("--not", dest="nots", action="append", default=[], help="style=minimal / view=landing")
    r.add_argument("--temp", help="全局温度 0-1(默认 0.3)")
    r.add_argument("--seed", help="随机种子(可复现)")

    f = sub.add_parser("fetch", help="按 id 或 query 取深")
    f.add_argument("--ids", "-i", help="逗号分隔的 short_id(最多 8)")
    f.add_argument("--query", "-q", help="按 gist 检索取深")
    f.add_argument("--count", "-n", help="query 模式条数 1-8(默认 1)")
    f.add_argument("--fields", help="gist/seed/reference/tags,默认 seed")
    f.add_argument("--ref-dim", dest="ref_dim", help="只取某几维 reference(逗号分隔)")
    return p


SLOP_REMINDER = """
<system-reminder>
You just fetched reference details. A critical warning: if your final product only borrows SURFACE (color values, font names) from these references, the task is a COMPLETE FAILURE.

You must learn beyond surface:
- Bolder creative ideas (the design decisions, the risk-taking choices)
- More refined details (the exact parameters, the craft, the micro-interactions)
- More complex logic (the structure, the motion choreography, the material layering, the interaction patterns)

When generating your product, keep these references present — do NOT fallback to your defaults after borrowing surface. Learn the HOW, not just the WHAT. If you can't point to a specific technique you borrowed from each reference (not a color/font), you haven't really learned it — go back and study the reference again.

Do not simplify or downgrade the reference's implementation. Do not skip core functionality the user needs. Do not nest containers unnecessarily (panel-in-panel). Verify your product actually works in the user's scenario.
</system-reminder>
"""


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "ensure-deps":
        return ensure_deps(args)
    if args.command == "recall":
        method, params = "musepool_recall", build_recall_params(args)
    else:
        method, params = "musepool_fetch", build_fetch_params(args)

    agent_gw_client, agent_gw_error = _ensure_sdk()
    try:
        with agent_gw_client(timeout=DEFAULT_TIMEOUT) as client:
            resp = client.tools.invoke(method, params)
    except agent_gw_error as exc:
        sys.stderr.write(f"muse_tool: 网关调用失败: {exc}\n")
        return 1

    # musepool 返回裸 JSON({"results",...}/{"items",...}),直接取 resp.raw;
    # 万一网关某天改走 {is_success,...} 信封且失败,这里兜底报错。
    raw = resp.raw
    if isinstance(raw, dict) and raw.get("is_success") is False:
        sys.stderr.write(f"muse_tool: 网关错误: {raw.get('error')}\n")
        return 1
    yaml, dumper = _ensure_yaml()
    yaml_output = yaml.dump(raw, Dumper=dumper, allow_unicode=True,
                            sort_keys=False, default_flow_style=False, width=4096)
    if args.command == "fetch":
        # system-reminder 放 fetch 输出开头(不截断 reference,截断由 harness 处理)
        sys.stdout.write(SLOP_REMINDER)
    sys.stdout.write(yaml_output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
