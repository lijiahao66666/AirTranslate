package com.lijiahao.read.service;

import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.core.type.AnnotatedTypeMetadata;

import java.io.IOException;

public class GPUPresentCondition implements Condition {
    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
        try {
            // 执行nvidia-smi命令检测GPU（仅适用于NVIDIA显卡）
            Process process = new ProcessBuilder("nvidia-smi").start();
            int exitCode = process.waitFor();
            return exitCode == 0; // 命令执行成功表示有GPU
        } catch (IOException | InterruptedException e) {
            return false; // 命令执行失败视为无GPU
        }
    }
}