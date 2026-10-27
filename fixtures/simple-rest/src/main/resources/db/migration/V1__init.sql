-- Initial schema
CREATE TABLE t_order (
    order_id    BIGINT PRIMARY KEY,
    customer_id BIGINT NOT NULL,
    amount      DECIMAL(12, 2)
);

CREATE TABLE t_order_line (
    line_id  BIGINT PRIMARY KEY,
    order_id BIGINT NOT NULL,
    sku      VARCHAR(64)
);

INSERT INTO t_order (order_id, customer_id, amount) VALUES (1, 1, 10.00);
