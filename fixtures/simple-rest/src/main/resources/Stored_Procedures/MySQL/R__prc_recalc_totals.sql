DROP PROCEDURE IF EXISTS prc_recalc_totals;
DELIMITER $$
CREATE PROCEDURE prc_recalc_totals(IN p_order_id BIGINT)
BEGIN
    UPDATE t_order SET amount = (SELECT COUNT(*) FROM t_order_line WHERE order_id = p_order_id) WHERE order_id = p_order_id;
END$$
DELIMITER ;
