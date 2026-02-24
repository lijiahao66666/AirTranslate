package com.airtranslate.billing;

public class PointsInsufficientException extends RuntimeException {

    private final int need;
    private final int balance;

    public PointsInsufficientException(String message, int need, int balance) {
        super(message);
        this.need = need;
        this.balance = balance;
    }

    public int getNeed() {
        return need;
    }

    public int getBalance() {
        return balance;
    }
}

