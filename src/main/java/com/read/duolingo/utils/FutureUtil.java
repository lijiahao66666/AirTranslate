package com.read.duolingo.utils;

import lombok.extern.slf4j.Slf4j;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

@Slf4j
public class FutureUtil {

    public static <T> List<T> collectFutures(List<CompletableFuture<T>> futures) {
        List<T> result = new java.util.ArrayList<>();
        futures.forEach(v -> {
            try {
                result.add(v.get(100000, TimeUnit.MILLISECONDS));
            } catch (Exception e) {
                log.error("Future 执行失败", e);
            }
        });
        return result;
    }
}
