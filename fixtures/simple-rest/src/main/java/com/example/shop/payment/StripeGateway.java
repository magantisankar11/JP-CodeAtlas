package com.example.shop.payment;

import org.springframework.web.client.RestTemplate;

import java.math.BigDecimal;

/** Not a stereotype bean: only a @Bean factory method makes it a Spring bean. */
public class StripeGateway implements PaymentGateway {

    private final RestTemplate restTemplate;

    private final String baseUrl;

    public StripeGateway(RestTemplate restTemplate, String baseUrl) {
        this.restTemplate = restTemplate;
        this.baseUrl = baseUrl;
    }

    @Override
    public String charge(Long orderId, BigDecimal amount) {
        return restTemplate.postForObject(baseUrl + "/charges/" + orderId, amount, String.class);
    }
}
