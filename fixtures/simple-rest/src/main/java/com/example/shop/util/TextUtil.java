package com.example.shop.util;

public final class TextUtil {

    private TextUtil() {
    }

    public static String mask(String value) {
        return mask(value, '*');
    }

    public static String mask(String value, char maskChar) {
        if (value == null || value.length() < 3) {
            return value;
        }
        return value.charAt(0) + String.valueOf(maskChar).repeat(value.length() - 2) + value.charAt(value.length() - 1);
    }
}
