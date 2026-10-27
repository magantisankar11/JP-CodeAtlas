package com.example.shop.service;

import com.example.shop.form.OrderForm;

import java.math.BigDecimal;

public interface PricingService {

    BigDecimal price(OrderForm form);
}
