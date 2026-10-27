package com.example.shop.util;

import java.math.BigDecimal;
import java.math.RoundingMode;

public final class PriceMath {

    private PriceMath() {
    }

    public static BigDecimal round(BigDecimal amount) {
        return amount.setScale(2, RoundingMode.HALF_UP);
    }
}
