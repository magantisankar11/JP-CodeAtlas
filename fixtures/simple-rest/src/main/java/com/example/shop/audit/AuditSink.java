package com.example.shop.audit;

public interface AuditSink {

    void write(String entry);
}
