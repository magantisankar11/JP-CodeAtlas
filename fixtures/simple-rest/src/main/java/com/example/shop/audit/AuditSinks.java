package com.example.shop.audit;

public final class AuditSinks {

    private AuditSinks() {
    }

    /** Product type is decided at runtime: the analyzer cannot know which AuditSink this bean is. */
    public static AuditSink fromEnvironment(String kind) {
        return "file".equals(kind) ? new FileAuditSink() : entry -> { };
    }
}
