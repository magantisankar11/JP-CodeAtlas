package com.example.shop.dao.impl;

import com.example.shop.dao.OrderDao;
import com.example.shop.entity.TOrder;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.util.List;

@Repository
public class OrderDaoImpl implements OrderDao {

    private static final String TABLE = "t_order";

    private static final String SELECT_BY_ID = "select * from " + TABLE + " where order_id = :id";

    @PersistenceContext
    private EntityManager entityManager;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Override
    public TOrder findById(Long orderId) {
        return (TOrder) entityManager.createNativeQuery(SELECT_BY_ID, TOrder.class)
                .setParameter("id", orderId)
                .getSingleResult();
    }

    @Override
    public Long insert(Long customerId, BigDecimal amount) {
        entityManager.createNativeQuery("insert into t_order (customer_id, amount) values (:c, :a)")
                .setParameter("c", customerId)
                .setParameter("a", amount)
                .executeUpdate();
        return customerId;
    }

    @Override
    @SuppressWarnings("unchecked")
    public List<TOrder> search(String query, String tenant) {
        StringBuilder sql = new StringBuilder("select * from ");
        sql.append(tenant).append("_orders where name like :q");
        return entityManager.createNativeQuery(sql.toString(), TOrder.class)
                .setParameter("q", query)
                .getResultList();
    }

    @Override
    @SuppressWarnings("unchecked")
    public List<TOrder> findByCustomer(Long customerId, boolean includeDeleted) {
        StringBuilder sql = new StringBuilder("select * from t_order where customer_id = :c");
        if (!includeDeleted) {
            sql.append(" and deleted = 0");
        }
        sql.append(" order by order_id");
        return entityManager.createNativeQuery(sql.toString(), TOrder.class)
                .setParameter("c", customerId)
                .getResultList();
    }

    @Override
    public void softDelete(Long orderId) {
        String sql = "update t_order set deleted = 1 where order_id = :id";
        entityManager.createNativeQuery(sql).setParameter("id", orderId).executeUpdate();
    }

    @Override
    public void hardDelete(Long orderId) {
        jdbcTemplate.update("delete from t_order_line where order_id = ?", orderId);
        jdbcTemplate.update("delete from t_order where order_id = ?", orderId);
        jdbcTemplate.update("call prc_recalc_totals(?)", orderId);
    }
}
