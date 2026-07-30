from __future__ import annotations

from typing import Any, Optional


class AgentGwError(Exception):
    """SDK 全部异常的基类。"""


class TransportError(AgentGwError):
    """网络/连接/超时失败 —— 请求尚未收到任何响应。"""


class APIError(AgentGwError):
    """agent-gw 返回的非 2xx HTTP 响应。"""

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        body: Any = None,
        request_id: Optional[str] = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.request_id = request_id

    def __str__(self) -> str:
        base = super().__str__()
        rid = f" (request_id={self.request_id})" if self.request_id else ""
        return f"[HTTP {self.status_code}]{rid} {base}"


class AuthenticationError(APIError):
    """401 —— API key 无效或已过期。"""


class PaymentRequiredError(APIError):
    """402 —— 需要付费或会员。"""


class QuotaExceededError(APIError):
    """403 —— 额度已耗尽。"""


class NotFoundError(APIError):
    """404 —— 路由或方法不存在。"""


class RateLimitError(APIError):
    """429 —— 被限速；如有 Retry-After 头会解析到 ``retry_after``。"""

    def __init__(self, *args, retry_after: Optional[float] = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.retry_after = retry_after


class ServerError(APIError):
    """5xx —— agent-gw 或下游故障。"""


class ToolError(AgentGwError):
    """``/v1/tools`` 信封返回 ``is_success=false`` 时抛出。"""

    def __init__(self, message: str, *, raw: Any = None):
        super().__init__(message)
        self.raw = raw
