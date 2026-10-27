package com.example.shop.checkout;

import com.example.shop.util.AuditHelper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class OrderPlacedListener {

    @Autowired
    private AuditHelper auditHelper;

    @EventListener
    public void onOrderPlaced(OrderPlacedEvent event) {
        auditHelper.record("placed", event.orderId());
    }
}
