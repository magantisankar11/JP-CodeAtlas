package com.example.shop.form;

import lombok.Data;

@Data
public class OrderLineForm {

    private String sku;

    private Integer quantity;
}
