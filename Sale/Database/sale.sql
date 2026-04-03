CREATE SCHEMA IF NOT EXISTS sale;

CREATE TABLE IF NOT EXISTS sale.payment_methods (
    code VARCHAR(20) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INT NOT NULL DEFAULT 0,
    requires_reference BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO sale.payment_methods (code, name, display_order, requires_reference)
VALUES
('cash', 'Tien mat', 1, FALSE),
('card', 'The', 2, TRUE),
('bank', 'Ngan hang', 3, TRUE),
('transfer', 'Chuyen khoan', 4, TRUE),
('momo', 'MoMo', 5, TRUE),
('zalopay', 'ZaloPay', 6, TRUE),
('vnpay', 'VNPay', 7, TRUE)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS sale.invoices (
    id UUID PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    customer_id UUID NULL,
    customer_code VARCHAR(20),
    customer_name VARCHAR(100),
    customer_phone VARCHAR(20),
    customer_tier VARCHAR(20),
    subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
    discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    tier_discount NUMERIC(15,2) NOT NULL DEFAULT 0,
    promotion_discount NUMERIC(15,2) NOT NULL DEFAULT 0,
    points_discount NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(15,2) NOT NULL,
    points_used INT NOT NULL DEFAULT 0,
    points_earned INT NOT NULL DEFAULT 0,
    promotion_id UUID,
    promotion_usage_id UUID,
    promotion_code VARCHAR(30),
    payment_method VARCHAR(20) NOT NULL,
    service_fee_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    service_fee_mode VARCHAR(20) NOT NULL DEFAULT 'split',
    amount_paid NUMERIC(15,2) NOT NULL,
    change_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'completed',
    cancelled_at TIMESTAMPTZ,
    cancelled_by VARCHAR(64),
    cancel_reason TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_by_name VARCHAR(100),
    cashier_code VARCHAR(20),
    commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    shift_id UUID,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sale.invoices ADD COLUMN IF NOT EXISTS service_fee_amount NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE sale.invoices ADD COLUMN IF NOT EXISTS service_fee_mode VARCHAR(20) NOT NULL DEFAULT 'split';

CREATE TABLE IF NOT EXISTS sale.invoice_items (
    id UUID PRIMARY KEY,
    invoice_id UUID NOT NULL REFERENCES sale.invoices(id) ON DELETE CASCADE,
    product_id VARCHAR(64) NOT NULL,
    product_code VARCHAR(50) NOT NULL,
    product_name VARCHAR(300) NOT NULL,
    unit_id VARCHAR(64) NOT NULL,
    unit_name VARCHAR(30) NOT NULL,
    conversion_rate INT NOT NULL DEFAULT 1,
    batch_id VARCHAR(64) NOT NULL,
    lot_number VARCHAR(50),
    expiry_date DATE,
    unit_price NUMERIC(12,2) NOT NULL,
    quantity INT NOT NULL,
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    line_total NUMERIC(15,2) NOT NULL,
    returned_quantity INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sale.invoice_payments (
    id UUID PRIMARY KEY,
    invoice_id UUID NOT NULL REFERENCES sale.invoices(id) ON DELETE CASCADE,
    payment_method VARCHAR(20) NOT NULL,
    amount NUMERIC(15,2) NOT NULL,
    reference_code VARCHAR(50),
    card_type VARCHAR(20),
    card_last_4 VARCHAR(4),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sale.held_orders (
    id UUID PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    customer_id UUID,
    customer_name VARCHAR(100),
    customer_phone VARCHAR(20),
    customer_tier VARCHAR(20),
    items JSONB NOT NULL,
    subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
    promotion_code VARCHAR(30),
    points_to_use INT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ NOT NULL,
    priority INT NOT NULL DEFAULT 0,
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_by_name VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resumed_at TIMESTAMPTZ,
    resumed_invoice_id UUID
);

CREATE TABLE IF NOT EXISTS sale.returns (
    id UUID PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    invoice_id UUID NOT NULL REFERENCES sale.invoices(id),
    invoice_code VARCHAR(30) NOT NULL,
    customer_id UUID,
    customer_name VARCHAR(100),
    total_return_amount NUMERIC(15,2) NOT NULL,
    points_returned INT NOT NULL DEFAULT 0,
    refund_method VARCHAR(20),
    refund_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    reason TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_by_name VARCHAR(100),
    approved_by VARCHAR(64),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sale.return_items (
    id UUID PRIMARY KEY,
    return_id UUID NOT NULL REFERENCES sale.returns(id) ON DELETE CASCADE,
    invoice_item_id UUID NOT NULL REFERENCES sale.invoice_items(id),
    product_id VARCHAR(64) NOT NULL,
    product_name VARCHAR(300) NOT NULL,
    unit_name VARCHAR(30) NOT NULL,
    batch_id VARCHAR(64) NOT NULL,
    quantity INT NOT NULL,
    unit_price NUMERIC(12,2) NOT NULL,
    return_amount NUMERIC(15,2) NOT NULL,
    reason TEXT,
    condition VARCHAR(20) NOT NULL DEFAULT 'good',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sale.shifts (
    id UUID PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    cashier_id VARCHAR(64) NOT NULL,
    cashier_name VARCHAR(100) NOT NULL,
    cashier_code VARCHAR(20),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    opening_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    closing_amount NUMERIC(15,2),
    expected_amount NUMERIC(15,2),
    difference NUMERIC(15,2),
    total_invoices INT NOT NULL DEFAULT 0,
    total_sales NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_returns NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_cancelled NUMERIC(15,2) NOT NULL DEFAULT 0,
    cash_sales NUMERIC(15,2) NOT NULL DEFAULT 0,
    card_sales NUMERIC(15,2) NOT NULL DEFAULT 0,
    transfer_sales NUMERIC(15,2) NOT NULL DEFAULT 0,
    momo_sales NUMERIC(15,2) NOT NULL DEFAULT 0,
    zalopay_sales NUMERIC(15,2) NOT NULL DEFAULT 0,
    vnpay_sales NUMERIC(15,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_code ON sale.invoices(code);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON sale.invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON sale.invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON sale.invoices(created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_shift ON sale.invoices(shift_id);
CREATE INDEX IF NOT EXISTS idx_invoices_cashier ON sale.invoices(created_by, created_at);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON sale.invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_product ON sale.invoice_items(product_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_batch ON sale.invoice_items(batch_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON sale.invoice_payments(invoice_id);

CREATE INDEX IF NOT EXISTS idx_held_orders_status ON sale.held_orders(status);
CREATE INDEX IF NOT EXISTS idx_held_orders_created_by ON sale.held_orders(created_by);
CREATE INDEX IF NOT EXISTS idx_held_orders_expires ON sale.held_orders(expires_at);

CREATE INDEX IF NOT EXISTS idx_returns_invoice ON sale.returns(invoice_id);
CREATE INDEX IF NOT EXISTS idx_returns_status ON sale.returns(status);

CREATE INDEX IF NOT EXISTS idx_shifts_cashier ON sale.shifts(cashier_id);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON sale.shifts(status);
CREATE INDEX IF NOT EXISTS idx_shifts_dates ON sale.shifts(started_at, ended_at);
