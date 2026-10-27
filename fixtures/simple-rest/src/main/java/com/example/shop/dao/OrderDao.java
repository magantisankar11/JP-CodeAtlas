package com.example.shop.dao;

import com.example.shop.entity.TOrder;

import java.math.BigDecimal;
import java.util.List;

public interface OrderDao {

    TOrder findById(Long orderId);

    Long insert(Long customerId, BigDecimal amount);

    List<TOrder> search(String query, String tenant);

    List<TOrder> findByCustomer(Long customerId, boolean includeDeleted);

    void softDelete(Long orderId);

    void hardDelete(Long orderId);
}
