package com.example.shop.form;

import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.math.BigDecimal;
import java.util.List;

@Data
public class OrderForm {

    private Long customerId;

    @NotNull
    private BigDecimal amount;

    private List<OrderLineForm> lines;
}
