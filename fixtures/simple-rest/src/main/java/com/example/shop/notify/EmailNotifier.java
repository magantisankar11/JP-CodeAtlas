package com.example.shop.notify;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

@Slf4j
@Component("emailNotifier")
public class EmailNotifier implements Notifier {

    @Override
    public void send(String message) {
        log.info("email: {}", message);
    }
}
