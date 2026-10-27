package com.example.shop.config;

import com.example.shop.audit.AuditSink;
import com.example.shop.audit.AuditSinks;
import com.example.shop.payment.PaymentGateway;
import com.example.shop.payment.StripeGateway;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestTemplate;

@Configuration
public class AppConfig {

    @Bean
    public RestTemplate restTemplate() {
        return new RestTemplate();
    }

    /** Known product: StripeGateway becomes a bean named "paymentGateway". */
    @Bean
    public PaymentGateway paymentGateway(RestTemplate restTemplate, @Value("${payment.gateway.url}") String url) {
        return new StripeGateway(restTemplate, url);
    }

    /** Opaque product: any AuditSink injection point stays ambiguous. */
    @Bean
    public AuditSink runtimeAuditSink() {
        return AuditSinks.fromEnvironment(System.getenv("AUDIT_SINK"));
    }
}
