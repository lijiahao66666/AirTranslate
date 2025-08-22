package com.read.duolingo.service.translators;

import com.read.duolingo.enums.TranslatorType;
import com.read.duolingo.utils.FutureUtil;

import java.util.List;
import java.util.concurrent.CompletableFuture;

public interface Translator {

    TranslatorType getTranslatorType();

    default String translate(String source, String langCode){
        return translate(source, langCode, true);
    }

    default List<String> translate(List<String> sources, String langCode){
        List<CompletableFuture<String>> futures = sources.stream().map(source -> asyncTranslate(source, langCode)).toList();
        return FutureUtil.collectFutures(futures);
    }

    default List<String> translate(List<String> sources, String langCode, boolean isOnline){
        List<CompletableFuture<String>> futures = sources.stream().map(source -> asyncTranslate(source, langCode, isOnline)).toList();
        return FutureUtil.collectFutures(futures);
    }

    default String translate(String source, String langCode, boolean isOnline){
        return asyncTranslate(source, langCode, isOnline).join();
    }

    default CompletableFuture<String> asyncTranslate(String source, String langCode){
        return asyncTranslate(source, langCode, true);
    }

    CompletableFuture<String> asyncTranslate(String source, String langCode, boolean isOnline);
}
