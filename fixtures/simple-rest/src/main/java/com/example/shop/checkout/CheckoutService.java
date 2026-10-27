package com.example.shop.checkout;

import com.amazonaws.services.s3.AmazonS3;
import com.example.shop.audit.AuditSink;
import com.example.shop.dao.OrderDao;
import com.example.shop.inventory.InventoryClient;
import com.example.shop.payment.PaymentGateway;
import org.jobrunr.scheduling.JobScheduler;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.math.BigDecimal;

@Service
public class CheckoutService {

    @Autowired
    private PaymentGateway paymentGateway;

    @Autowired
    private AuditSink auditSink;

    @Autowired
    private InventoryClient inventoryClient;

    @Autowired
    private RestTemplate restTemplate;

    @Autowired
    private AmazonS3 s3;

    @Autowired
    private JobScheduler jobScheduler;

    @Autowired
    private ApplicationEventPublisher publisher;

    @Autowired
    private Environment env;

    @Autowired
    private OrderDao orderDao;

    @Value("${payment.gateway.url}")
    private String gatewayUrl;

    public String checkout(Long orderId, String sku, BigDecimal amount) {
        if (inventoryClient.stock(sku) <= 0) {
            throw new IllegalStateException("Out of stock: " + sku);
        }
        String receipt = paymentGateway.charge(orderId, amount);
        auditSink.write("charged " + orderId);
        restTemplate.getForObject("https://status.example.com/health", String.class);
        restTemplate.postForObject(gatewayUrl + "/receipts", receipt, String.class);
        restTemplate.exchange(receiptUrl(orderId), HttpMethod.GET, null, String.class);
        s3.putObject("receipts", orderId + ".txt", receipt);
        jobScheduler.enqueue(() -> reconcile(orderId));
        publisher.publishEvent(new OrderPlacedEvent(orderId));
        if (Boolean.parseBoolean(env.getProperty("notify.sms.enabled"))) {
            auditSink.write("sms " + orderId);
        }
        return receipt;
    }

    public void reconcile(Long orderId) {
        orderDao.findById(orderId);
    }

    private String receiptUrl(Long orderId) {
        return "https://receipts." + System.getenv("REGION") + ".example.com/" + orderId;
    }
}
