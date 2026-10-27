package com.example.shop.service.impl;

import com.example.shop.form.OrderForm;
import com.example.shop.service.PricingService;
import com.example.shop.util.PriceMath;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;

@Service
public class StandardPricingService implements PricingService {

    @Override
    public BigDecimal price(OrderForm form) {
        return PriceMath.round(form.getAmount());
    }
}
