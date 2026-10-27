package com.example.shop.inventory;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;

@FeignClient(name = "inventory", url = "${inventory.url}", path = "/api")
public interface InventoryClient {

    @GetMapping("/stock/{sku}")
    Integer stock(@PathVariable("sku") String sku);
}
