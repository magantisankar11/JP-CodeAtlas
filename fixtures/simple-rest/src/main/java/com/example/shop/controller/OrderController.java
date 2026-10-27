package com.example.shop.controller;

import com.example.shop.form.OrderForm;
import com.example.shop.service.OrderService;
import com.example.shop.service.PricingService;
import com.example.shop.util.ApiPaths;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.util.List;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    @Autowired
    private PricingService pricingService;

    @Autowired
    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping("/{orderId}")
    public ResponseEntity<OrderForm> getOrder(@PathVariable Long orderId) {
        return ResponseEntity.ok(orderService.getOrder(orderId));
    }

    @PostMapping
    public ResponseEntity<Long> createOrder(@Valid @RequestBody OrderForm form) {
        return ResponseEntity.ok(orderService.createOrder(form));
    }

    @GetMapping(value = {"/search", "search/v2"})
    public List<OrderForm> search(@RequestParam("q") String query, @RequestHeader("X-Tenant") String tenant) {
        return orderService.search(query, tenant);
    }

    @DeleteMapping("/{orderId}")
    public void deleteOrder(@PathVariable("orderId") Long id) {
        orderService.deleteOrder(id);
    }

    @RequestMapping(value = ApiPaths.QUOTE, method = RequestMethod.POST)
    public BigDecimal quote(@RequestBody OrderForm form) {
        return pricingService.price(form);
    }
}
