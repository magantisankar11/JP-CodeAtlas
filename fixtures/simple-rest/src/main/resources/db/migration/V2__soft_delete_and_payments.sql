ALTER TABLE t_order ADD COLUMN deleted INT DEFAULT 0;

CREATE TABLE t_payment (
    payment_id        BIGINT PRIMARY KEY,
    order_id          BIGINT NOT NULL,
    gateway_reference VARCHAR(128)
);
