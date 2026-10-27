package com.example.shop.payment;

import java.math.BigDecimal;

public interface PaymentGateway {

    String charge(Long orderId, BigDecimal amount);
}
