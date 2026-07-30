"""Kimi agent-gw（Kimi For Coding Backend）的 Python SDK。

快速开始::

    from agent_gw import AgentGwClient

    client = AgentGwClient(api_key="sk-...", base_url="https://agent-gw-dev.dev.kimi.team")
    rsp = client.tools.stock_realtime_price(
        ticker="600519.SH",
        time="2025-06-08 10:30:00",
        type="realtime_price",
    )
    if rsp.is_success:
        print(rsp.json())

详细说明见 README.md。
"""

# ── 版本号解析 ────────────────────────────────────────────────────────────────
# 版本号唯一真值 = 最近的 git tag，由 setuptools_scm 在构建/安装时
# 写入 ``_version.py``。该文件已加入 .gitignore，**禁止手动修改**。
#
# 按顺序兜底（覆盖各种使用场景）：
#   1. ``_version.py`` 存在    —— pip install / pip install -e 之后的常态
#   2. 包元数据 (importlib.metadata) —— 装好但 _version.py 被删的兼容
#   3. ``0.0.0+local``         —— 纯 git clone 没安装过的开发态
try:
    from ._version import __version__
except ImportError:
    try:
        from importlib.metadata import version as _pkg_version, PackageNotFoundError

        try:
            __version__ = _pkg_version("agent-gw")
        except PackageNotFoundError:
            __version__ = "0.0.0+local"
    except ImportError:  # Python < 3.8 兜底，本仓库实际不会触发
        __version__ = "0.0.0+local"

from .client import (
    AgentGwClient,
    API_KEY_ENV_VAR,
    BASE_URL_ENV_VAR,
    CONFIG_FILE,
    DEFAULT_BASE_URL,
    DEFAULT_USER_AGENT,
    ToolResponse,
    ToolsAPI,
)
from .errors import (
    AgentGwError,
    APIError,
    AuthenticationError,
    NotFoundError,
    PaymentRequiredError,
    QuotaExceededError,
    RateLimitError,
    ServerError,
    ToolError,
    TransportError,
)

__all__ = [
    "__version__",
    "AgentGwClient",
    "ToolResponse",
    "ToolsAPI",
    "API_KEY_ENV_VAR",
    "BASE_URL_ENV_VAR",
    "CONFIG_FILE",
    "DEFAULT_BASE_URL",
    "DEFAULT_USER_AGENT",
    "AgentGwError",
    "APIError",
    "AuthenticationError",
    "NotFoundError",
    "PaymentRequiredError",
    "QuotaExceededError",
    "RateLimitError",
    "ServerError",
    "ToolError",
    "TransportError",
]
