package com.example.shop.audit;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** JPA property access: mapping annotations sit on the getters, as in much of JustPerform-Core. */
@Entity
@Table(name = "t_audit_log")
public class TAuditLog {

    private Long logId;

    private String text;

    @Id
    @Column(name = "log_id")
    public Long getLogId() {
        return logId;
    }

    public void setLogId(Long logId) {
        this.logId = logId;
    }

    @Column(name = "log_text")
    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }
}
