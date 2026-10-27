package com.example.shop.service.impl;

import com.example.shop.dao.OrderDao;
import com.example.shop.entity.TOrder;
import com.example.shop.form.OrderForm;
import com.example.shop.notify.Notifier;
import com.example.shop.service.OrderNotFoundException;
import com.example.shop.service.OrderService;
import com.example.shop.util.AuditHelper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class OrderServiceImpl implements OrderService {

    private final OrderDao orderDao;

    private final Notifier notifier;

    @Autowired
    private AuditHelper auditHelper;

    public OrderServiceImpl(OrderDao orderDao, @Qualifier("emailNotifier") Notifier notifier) {
        this.orderDao = orderDao;
        this.notifier = notifier;
    }

    @Override
    public OrderForm getOrder(Long orderId) {
        TOrder order = orderDao.findById(orderId);
        if (order == null) {
            throw new OrderNotFoundException(orderId);
        }
        auditHelper.record("read", orderId);
        return toForm(order);
    }

    @Override
    @Transactional
    public Long createOrder(OrderForm form) {
        Long orderId = orderDao.insert(form.getCustomerId(), form.getAmount());
        notifier.send("created " + orderId);
        auditHelper.record("create", orderId);
        return orderId;
    }

    @Override
    public List<OrderForm> search(String query, String tenant) {
        return orderDao.search(query, tenant).stream().map(this::toForm).toList();
    }

    @Override
    public void deleteOrder(Long orderId) {
        deleteOrder(orderId, false);
    }

    @Override
    @Transactional
    public void deleteOrder(Long orderId, boolean hard) {
        if (hard) {
            orderDao.hardDelete(orderId);
        } else {
            orderDao.softDelete(orderId);
        }
        auditHelper.record("delete", orderId);
        auditHelper.flushAsync();
    }

    @Override
    public void recalculate(int depth) {
        if (depth > 0) {
            recalculate(depth - 1);
        }
    }

    private OrderForm toForm(TOrder order) {
        OrderForm form = new OrderForm();
        form.setCustomerId(order.getCustomerId());
        form.setAmount(order.getAmount());
        return form;
    }
}
