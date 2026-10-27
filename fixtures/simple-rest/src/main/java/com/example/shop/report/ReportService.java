package com.example.shop.report;

import com.example.shop.form.OrderForm;
import com.example.shop.notify.Notifier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class ReportService {

    // Two Notifier beans exist; Spring falls back to the injection-point name.
    @Autowired
    private Notifier smsNotifier;

    // Same name and signature as OrderService.getOrder but never called: must not be linked.
    public OrderForm getOrder(Long orderId) {
        return new OrderForm();
    }

    public void sendDaily() {
        smsNotifier.send("daily");
    }

    @Scheduled(cron = "0 0 1 * * *")
    public void nightly() {
        sendDaily();
    }

    public Object invokeDynamic(String methodName) throws Exception {
        return getClass().getMethod(methodName).invoke(this);
    }

    public int ping(int n) {
        return n <= 0 ? 0 : pong(n - 1);
    }

    public int pong(int n) {
        return ping(n);
    }
}
