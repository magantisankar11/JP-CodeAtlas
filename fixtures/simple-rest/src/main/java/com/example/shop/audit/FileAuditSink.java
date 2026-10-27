package com.example.shop.audit;

import org.springframework.stereotype.Component;

@Component
public class FileAuditSink implements AuditSink {

    @Override
    public void write(String entry) {
        System.out.println(entry);
    }
}
