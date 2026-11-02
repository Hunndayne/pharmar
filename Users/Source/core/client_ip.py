"""Resolve the real client IP behind the API gateway.

The gateway resolves the client IP from its trusted-proxy rules, strips any
client-supplied X-Client-IP and sets its own. The Users service is only
reachable through the gateway, so the header is trusted when it is a valid IP;
otherwise we fall back to the direct peer address.
"""

import ipaddress

from fastapi import Request

CLIENT_IP_HEADER = "x-client-ip"


def get_client_ip(request: Request) -> str | None:
    header_value = request.headers.get(CLIENT_IP_HEADER, "").strip()
    if header_value:
        try:
            return str(ipaddress.ip_address(header_value))
        except ValueError:
            pass
    if request.client:
        return request.client.host
    return None


def client_ip_key(request: Request) -> str:
    """slowapi key function."""
    return get_client_ip(request) or "unknown"
