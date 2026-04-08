"""Shared HTML email templates for all notification types."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation


# ── base layout ───────────────────────────────────────────────────────────────

_BASE_EMAIL = """<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

      <!-- Header -->
      <tr><td style="background:#111827;border-radius:12px 12px 0 0;padding:22px 32px;text-align:center">
        <span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px">Pharmar</span>
        <span style="display:block;font-size:10px;color:#9ca3af;margin-top:3px;letter-spacing:0.1em;text-transform:uppercase">Quản lý nhà thuốc</span>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#ffffff;padding:28px 32px">
        {BODY}
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f9fafb;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none;padding:14px 32px;text-align:center">
        <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.6">
          Email tự động từ hệ thống <strong style="color:#6b7280">Pharmar</strong>.
          Vui lòng không trả lời email này.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""


# ── shared helpers ────────────────────────────────────────────────────────────

def fmt_money(amount) -> str:
    try:
        value = int(Decimal(str(amount)))
        return f"{value:,}đ".replace(",", ".")
    except (InvalidOperation, TypeError, ValueError):
        return str(amount)


def _badge(label: str, bg: str, color: str) -> str:
    return (
        f"<span style=\"display:inline-block;background:{bg};color:{color};"
        f"font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;"
        f"letter-spacing:0.06em;text-transform:uppercase\">{label}</span>"
    )


def _cta_button(label: str, url: str, bg: str = "#111827") -> str:
    return (
        f"<div style=\"text-align:center;margin-top:24px\">"
        f"<a href=\"{url}\" target=\"_blank\" "
        f"style=\"display:inline-block;background:{bg};color:#ffffff;font-size:14px;"
        f"font-weight:600;text-decoration:none;padding:13px 30px;border-radius:8px;"
        f"letter-spacing:0.01em\">{label} →</a></div>"
    )


def _detail_row(label: str, value: str, last: bool = False) -> str:
    border = "" if last else "border-bottom:1px solid #f3f4f6"
    return (
        f"<tr>"
        f"<td style=\"padding:10px 0;{border};font-size:12px;color:#6b7280;"
        f"width:140px;vertical-align:top;padding-right:16px\">{label}</td>"
        f"<td style=\"padding:10px 0;{border};font-size:13px;color:#111827;"
        f"font-weight:500;vertical-align:top\">{value}</td>"
        f"</tr>"
    )


def _section_title(text: str) -> str:
    return (
        f"<p style=\"margin:20px 0 8px;font-size:11px;font-weight:600;color:#9ca3af;"
        f"letter-spacing:0.08em;text-transform:uppercase\">{text}</p>"
    )


def _render(body: str) -> str:
    return _BASE_EMAIL.replace("{BODY}", body)


# ── invoice created ───────────────────────────────────────────────────────────

PAYMENT_METHOD_LABELS: dict[str, str] = {
    "cash": "Tiền mặt",
    "card": "Thẻ ngân hàng",
    "bank_transfer": "Chuyển khoản",
    "momo": "MoMo",
    "zalopay": "ZaloPay",
    "vnpay": "VNPay",
    "debt": "Mua nợ",
    "points": "Điểm thưởng",
}


def build_invoice_created_email(payload: dict, frontend_url: str) -> str:
    code = payload.get("invoice_code", "")
    amount = fmt_money(payload.get("total_amount", 0))
    payment = PAYMENT_METHOD_LABELS.get(payload.get("payment_method", ""), payload.get("payment_method", ""))
    cashier = payload.get("created_by_name") or "—"
    customer_name = payload.get("customer_name") or "Khách lẻ"
    customer_phone = payload.get("customer_phone") or ""
    discount = payload.get("discount_amount") or 0
    subtotal = payload.get("subtotal") or 0

    rows = _detail_row("Mã hóa đơn", f"<span style='font-family:monospace;font-size:13px;background:#f9fafb;padding:2px 6px;border-radius:4px'>{code}</span>")
    if subtotal and discount:
        rows += _detail_row("Tạm tính", fmt_money(subtotal))
        rows += _detail_row("Giảm giá", f"<span style='color:#ef4444'>−{fmt_money(discount)}</span>")
    rows += _detail_row("Tổng tiền", f"<span style='font-size:17px;font-weight:700;color:#111827'>{amount}</span>")
    rows += _detail_row("Thanh toán", payment)
    rows += _detail_row("Thu ngân", cashier)
    customer_str = customer_name + (f" &middot; {customer_phone}" if customer_phone else "")
    rows += _detail_row("Khách hàng", customer_str, last=True)

    lookup_url = f"{frontend_url}/tra-cuu-hoa-don?mode=code&code={code}"

    body = f"""
      <div style="margin-bottom:18px">{_badge("Hóa đơn mới", "#f0fdf4", "#16a34a")}</div>
      <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827">{code}</h2>
      <p style="margin:0 0 20px;font-size:13px;color:#9ca3af">Giao dịch vừa được tạo thành công</p>
      <table width="100%" cellpadding="0" cellspacing="0">{rows}</table>
      {_cta_button("Xem chi tiết hóa đơn", lookup_url)}
      <p style="margin:12px 0 0;font-size:11px;color:#9ca3af;text-align:center">
        Liên kết có hiệu lực trong 30 ngày
      </p>
    """
    return _render(body)


# ── invoice cancelled ─────────────────────────────────────────────────────────

def build_invoice_cancelled_email(payload: dict, frontend_url: str) -> str:
    code = payload.get("invoice_code", "")
    amount = fmt_money(payload.get("total_amount", 0))
    reason = payload.get("cancel_reason") or "Không có lý do"
    lookup_url = f"{frontend_url}/tra-cuu-hoa-don?mode=code&code={code}"

    rows = _detail_row("Mã hóa đơn", f"<span style='font-family:monospace;font-size:13px'>{code}</span>")
    rows += _detail_row("Giá trị", f"<span style='text-decoration:line-through;color:#9ca3af'>{amount}</span>")
    rows += _detail_row("Lý do hủy", reason, last=True)

    body = f"""
      <div style="margin-bottom:18px">{_badge("Hóa đơn bị hủy", "#fef2f2", "#dc2626")}</div>
      <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827">{code}</h2>
      <p style="margin:0 0 20px;font-size:13px;color:#9ca3af">Hóa đơn đã bị hủy và không còn hiệu lực</p>
      <table width="100%" cellpadding="0" cellspacing="0">{rows}</table>
      {_cta_button("Xem hóa đơn", lookup_url, bg="#6b7280")}
    """
    return _render(body)


# ── return approved ───────────────────────────────────────────────────────────

def build_return_approved_email(payload: dict, frontend_url: str) -> str:
    return_code = payload.get("return_code", "")
    invoice_code = payload.get("invoice_code", "")
    refund = fmt_money(payload.get("refund_amount", 0))
    customer_name = payload.get("customer_name") or "Khách lẻ"
    lookup_url = f"{frontend_url}/tra-cuu-hoa-don?mode=code&code={invoice_code}"

    rows = _detail_row("Phiếu trả hàng", f"<span style='font-family:monospace'>{return_code}</span>")
    rows += _detail_row("Hóa đơn gốc", f"<span style='font-family:monospace'>{invoice_code}</span>")
    rows += _detail_row("Số tiền hoàn", f"<span style='font-size:16px;font-weight:700;color:#2563eb'>{refund}</span>")
    rows += _detail_row("Khách hàng", customer_name, last=True)

    body = f"""
      <div style="margin-bottom:18px">{_badge("Trả hàng được duyệt", "#eff6ff", "#2563eb")}</div>
      <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827">{return_code}</h2>
      <p style="margin:0 0 20px;font-size:13px;color:#9ca3af">Phiếu trả hàng đã được duyệt</p>
      <table width="100%" cellpadding="0" cellspacing="0">{rows}</table>
      {_cta_button("Xem hóa đơn gốc", lookup_url, bg="#2563eb")}
    """
    return _render(body)


# ── low stock ─────────────────────────────────────────────────────────────────

def build_low_stock_email(items: list[dict], frontend_url: str) -> str:
    total = len(items)
    shown = items[:8]
    hidden = total - len(shown)

    rows_html = ""
    for item in shown:
        name = item.get("drug_name", "?")
        qty = item.get("current_qty", 0)
        threshold = item.get("threshold", 0)
        bar_pct = min(100, int(qty / threshold * 100)) if threshold > 0 else 0
        bar_color = "#ef4444" if bar_pct == 0 else "#f59e0b" if bar_pct < 50 else "#3b82f6"
        qty_str = (
            f"<span style='color:#ef4444;font-weight:700'>{qty}</span>"
            if qty == 0
            else f"<span style='color:#f59e0b;font-weight:700'>{qty}</span>"
        )
        rows_html += f"""
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;vertical-align:top">
            <p style="margin:0;font-size:13px;font-weight:600;color:#111827">{name}</p>
            <div style="margin-top:5px;background:#f3f4f6;border-radius:4px;height:4px;width:160px">
              <div style="background:{bar_color};width:{bar_pct}%;height:4px;border-radius:4px"></div>
            </div>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;text-align:right;vertical-align:top;white-space:nowrap">
            {qty_str}
            <span style="font-size:11px;color:#9ca3af"> / {threshold}</span>
          </td>
        </tr>"""

    if hidden > 0:
        rows_html += f"""
        <tr><td colspan="2" style="padding:10px 0;font-size:12px;color:#9ca3af;text-align:center">
          ... và {hidden} sản phẩm khác
        </td></tr>"""

    inventory_url = f"{frontend_url}/ton-kho"

    body = f"""
      <div style="margin-bottom:18px">{_badge("Cảnh báo tồn kho", "#fffbeb", "#d97706")}</div>
      <h2 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#111827">
        {total} sản phẩm dưới mức tối thiểu
      </h2>
      <p style="margin:0 0 24px;font-size:13px;color:#9ca3af">
        Cần nhập hàng sớm để tránh gián đoạn kinh doanh
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr>
          <th style="font-size:11px;color:#9ca3af;font-weight:500;text-align:left;padding-bottom:8px;
                     letter-spacing:0.06em;text-transform:uppercase;border-bottom:2px solid #f3f4f6">
            Sản phẩm
          </th>
          <th style="font-size:11px;color:#9ca3af;font-weight:500;text-align:right;padding-bottom:8px;
                     letter-spacing:0.06em;text-transform:uppercase;border-bottom:2px solid #f3f4f6">
            Tồn / Ngưỡng
          </th>
        </tr>
        {rows_html}
      </table>
      {_cta_button("Vào quản lý tồn kho", inventory_url, bg="#d97706")}
    """
    return _render(body)


# ── expiry warning ────────────────────────────────────────────────────────────

def build_expiry_email(
    expired: list[dict],
    expiring_soon: list[dict],
    warning: list[dict],
    frontend_url: str,
) -> str:
    total = len(expired) + len(expiring_soon) + len(warning)

    def _expiry_row(entry: dict, tag: str, tag_color: str, tag_bg: str) -> str:
        b = entry.get("batch", {})
        name = b.get("drug_name", "?")
        batch_code = b.get("batch_code", "?")
        days = entry.get("days_to_expiry", 0)
        qty = b.get("qty_remaining", 0)
        days_str = (
            f"<span style='color:#ef4444'>Đã hết hạn {abs(days)} ngày</span>"
            if days < 0
            else f"Còn {days} ngày"
        )
        return f"""
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;vertical-align:top">
            <p style="margin:0 0 3px;font-size:13px;font-weight:600;color:#111827">{name}</p>
            <p style="margin:0;font-size:11px;color:#9ca3af;font-family:monospace">Lô {batch_code}</p>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;text-align:center;vertical-align:top">
            <span style="display:inline-block;background:{tag_bg};color:{tag_color};
                         font-size:10px;font-weight:600;padding:2px 8px;border-radius:12px">
              {tag}
            </span>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;text-align:right;
                     vertical-align:top;white-space:nowrap;font-size:12px;color:#374151">
            {days_str}<br>
            <span style="color:#9ca3af">Tồn: {qty}</span>
          </td>
        </tr>"""

    rows_html = ""
    for e in expired[:3]:
        rows_html += _expiry_row(e, "Hết hạn", "#dc2626", "#fef2f2")
    for e in expiring_soon[:3]:
        rows_html += _expiry_row(e, "< 30 ngày", "#d97706", "#fffbeb")
    for e in warning[:3]:
        rows_html += _expiry_row(e, "30–60 ngày", "#2563eb", "#eff6ff")

    shown = min(total, 9)
    if total > shown:
        rows_html += f"""
        <tr><td colspan="3" style="padding:10px 0;font-size:12px;color:#9ca3af;text-align:center">
          ... và {total - shown} lô khác
        </td></tr>"""

    summary_parts = []
    if expired:
        summary_parts.append(f"<span style='color:#dc2626;font-weight:600'>{len(expired)} lô hết hạn</span>")
    if expiring_soon:
        summary_parts.append(f"<span style='color:#d97706;font-weight:600'>{len(expiring_soon)} lô sắp hết hạn</span>")
    if warning:
        summary_parts.append(f"<span style='color:#2563eb;font-weight:600'>{len(warning)} lô cảnh báo</span>")

    expiry_url = f"{frontend_url}/han-su-dung"

    body = f"""
      <div style="margin-bottom:18px">{_badge("Cảnh báo hạn sử dụng", "#fef2f2", "#dc2626")}</div>
      <h2 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#111827">
        {total} lô thuốc cần xử lý
      </h2>
      <p style="margin:0 0 24px;font-size:13px;color:#9ca3af">
        {" &nbsp;·&nbsp; ".join(summary_parts)}
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr>
          <th style="font-size:11px;color:#9ca3af;font-weight:500;text-align:left;padding-bottom:8px;
                     letter-spacing:0.06em;text-transform:uppercase;border-bottom:2px solid #f3f4f6">
            Thuốc / Lô
          </th>
          <th style="font-size:11px;color:#9ca3af;font-weight:500;text-align:center;padding-bottom:8px;
                     letter-spacing:0.06em;text-transform:uppercase;border-bottom:2px solid #f3f4f6">
            Trạng thái
          </th>
          <th style="font-size:11px;color:#9ca3af;font-weight:500;text-align:right;padding-bottom:8px;
                     letter-spacing:0.06em;text-transform:uppercase;border-bottom:2px solid #f3f4f6">
            Thời hạn
          </th>
        </tr>
        {rows_html}
      </table>
      {_cta_button("Vào quản lý hạn sử dụng", expiry_url, bg="#dc2626")}
    """
    return _render(body)


# ── generic fallback ──────────────────────────────────────────────────────────

def build_generic_email(title: str, body_text: str, cta_url: str | None = None, cta_label: str = "Xem chi tiết") -> str:
    cta = _cta_button(cta_label, cta_url) if cta_url else ""
    body = f"""
      <h2 style="margin:0 0 16px;font-size:18px;font-weight:700;color:#111827">{title}</h2>
      <p style="margin:0;font-size:14px;color:#374151;line-height:1.7;white-space:pre-line">{body_text}</p>
      {cta}
    """
    return _render(body)
