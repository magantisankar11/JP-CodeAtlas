package com.example.shop.service;

import com.example.shop.form.OrderForm;

import java.util.List;

public interface OrderService {

    OrderForm getOrder(Long orderId);

    Long createOrder(OrderForm form);

    List<OrderForm> search(String query, String tenant);

    void deleteOrder(Long orderId);

    void deleteOrder(Long orderId, boolean hard);

    void recalculate(int depth);
}
