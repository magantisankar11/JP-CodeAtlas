package com.example.shop.service.impl;

import com.example.shop.form.OrderForm;
import com.example.shop.service.PricingService;
import com.example.shop.util.PriceMath;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;

@Service
public class DiscountPricingService implements PricingService {

    private static final BigDecimal DISCOUNT = new BigDecimal("0.9");

    @Override
    public BigDecimal price(OrderForm form) {
        return PriceMath.round(form.getAmount().multiply(DISCOUNT));
    }
}
