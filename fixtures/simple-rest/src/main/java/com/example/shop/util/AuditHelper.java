package com.example.shop.util;

import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;

@Slf4j
@Component
public class AuditHelper {

    private int recorded;

    public void record(String action, Long id) {
        recorded++;
        log.info("audit {} {} #{}", action, TextUtil.mask(String.valueOf(id)), getRecorded());
    }

    // Hand-written trivial getter: must be classified as an accessor by its body, like Lombok ones.
    public int getRecorded() {
        return recorded;
    }

    @Async
    public void flushAsync() {
        log.debug("flush");
    }
}
