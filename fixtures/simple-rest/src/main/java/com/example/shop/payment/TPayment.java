package com.example.shop.payment;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Data;

@Data
@Entity
@Table(name = "t_payment")
public class TPayment {

    @Id
    @Column(name = "payment_id")
    private Long paymentId;

    @Column(name = "order_id")
    private Long orderId;

    // Default naming gives gateway_ref, but the migration created gateway_reference: must be reported.
    private String gatewayRef;
}
