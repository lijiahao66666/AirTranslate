package com.read.duolingo.service.translators;

import com.alibaba.fastjson2.JSON;
import com.knuddels.jtokkit.Encodings;
import com.knuddels.jtokkit.api.Encoding;
import lombok.Getter;
import lombok.Setter;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicInteger;

@Slf4j
@Setter
@Service
public class LocalSeedXTranslator {

    private RestTemplate restTemplate = new RestTemplate();

    private final static Integer seedXTotalMaxTokens = 51000;
    private final AtomicInteger currentSeedXTokens = new AtomicInteger(0);
    private Encoding encoding = Encodings.newDefaultEncodingRegistry().getEncodingForModel("gpt-4").get();

    private static final long WAIT_TIMEOUT = 60000;
    private static final long WAIT_INTERVAL = 200;

    // 优先级阻塞队列 - 根据优先级和提交顺序排序
    private final PriorityBlockingQueue<PriorityTask> taskQueue = new PriorityBlockingQueue<>();

    // 工作线程池
    private final ThreadPoolTaskExecutor seedXExecutor = new ThreadPoolTaskExecutor();

    public LocalSeedXTranslator() {
        // 初始化线程池
        seedXExecutor.setCorePoolSize(100);
        seedXExecutor.setMaxPoolSize(100);
        seedXExecutor.setRejectedExecutionHandler(new ThreadPoolExecutor.DiscardPolicy());
        seedXExecutor.initialize();

        // 启动消费者线程
        // 消费者线程 - 从优先级队列中取出任务执行
        Thread consumerThread = new Thread(this::consumeTasks, "LLMService-Consumer");
        consumerThread.setDaemon(true);
        consumerThread.start();
    }

    // 消费者线程方法 - 从队列中取出任务并执行
    private void consumeTasks() {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                PriorityTask task = taskQueue.take(); // 阻塞直到有任务可用
                seedXExecutor.execute(task);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    public CompletableFuture<String> seedGenerateText(String prompt, boolean isOnline) {
        if(StringUtils.isBlank(prompt)){
            return CompletableFuture.completedFuture("");
        }
        CompletableFuture<String> future = new CompletableFuture<>();
        // 创建任务并添加到优先级队列
        PriorityTask task = new PriorityTask(prompt, isOnline, future);
        taskQueue.put(task);

        return future;
    }

    // 优先级任务内部类
    private class PriorityTask implements Runnable, Comparable<PriorityTask> {
        private final String prompt;
        private final boolean isOnline;
        private final CompletableFuture<String> future;
        private final long sequenceNumber; // 用于保证相同优先级的任务按提交顺序执行

        public PriorityTask(String prompt, boolean isOnline, CompletableFuture<String> future) {
            this.prompt = prompt;
            this.isOnline = isOnline;
            this.future = future;
            this.sequenceNumber = System.nanoTime();
        }

        @Override
        public void run() {
            try {
                String result = executeRequest();
                future.complete(result);
            } catch (Exception e) {
                future.completeExceptionally(e);
            }
        }

        private String executeRequest() {
            SeedXCompletionRequest request = new SeedXCompletionRequest(prompt);
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            HttpEntity<SeedXCompletionRequest> requestEntity = new HttpEntity<>(request, headers);

            int tokenCost = calculateTokenCost(prompt);
            if (tokenCost > request.getMax_tokens()){
                log.error("当前文本token超过限制，tokenCost:{}", tokenCost);
                return "";
            }
            log.info("调用seedx生成文本，prompt:{}，tokenCost:{}", prompt, tokenCost);

            // 最多重试2次
            for (int i = 0; i < 2; i++) {
                if (!acquireTokens(currentSeedXTokens, tokenCost)) {
                    log.warn("获取seedx tokens超时，放弃请求");
                    continue;
                }

                try {
                    SeedXCompletionResponse response = restTemplate.postForObject(
                            "http://localhost:8000/v1/completions",
                            requestEntity,
                            SeedXCompletionResponse.class
                    );

                    if (response != null && response.getChoices() != null && !response.getChoices().isEmpty()) {
                        log.info("调用seedx生成文本成功, response:{}", JSON.toJSONString(response));
                        String result = response.getChoices().stream()
                                .map(SeedXCompletionResponse.Choice::getText)
                                .toList()
                                .getFirst();

                        int index = result.indexOf("（注");
                        if (index != -1) {
                            result = result.substring(0, index).trim();
                        }
                        index = result.indexOf("[COT]");
                        if (index != -1) {
                            result = result.substring(0, index).trim();
                        }
                        return result.replace("\"", "'");
                    }
                } catch (Exception e) {
                    log.error("调用seedx生成文本失败, requestEntity:{}", JSON.toJSONString(requestEntity), e);
                } finally {
                    currentSeedXTokens.addAndGet(-tokenCost);
                }
            }
            log.error("请求seedx生成文本失败，tokenCost:{}", tokenCost);
            return "";
        }

        @Override
        public int compareTo(PriorityTask other) {
            // 优先比较优先级：isOnline=true的优先级更高
            if (this.isOnline && !other.isOnline) {
                return -1; // 当前任务优先级更高
            } else if (!this.isOnline && other.isOnline) {
                return 1; // 其他任务优先级更高
            } else {
                // 相同优先级时，比较提交顺序
                return Long.compare(this.sequenceNumber, other.sequenceNumber);
            }
        }
    }

    public int calculateTokenCost(String prompt) {
        int tokenCount = encoding.countTokens(prompt);
        return tokenCount + (Math.max(tokenCount, 30));
    }

    private boolean acquireTokens(AtomicInteger tokenCounter, int requiredTokens) {
        long startTime = System.currentTimeMillis();

        while (true) {
            int current = tokenCounter.get();
            int newCount = current + requiredTokens;

            if (newCount <= LocalSeedXTranslator.seedXTotalMaxTokens) {
                if (tokenCounter.compareAndSet(current, newCount)) {
                    return true;
                }
            }

            if (System.currentTimeMillis() - startTime > WAIT_TIMEOUT) {
                return false;
            }

            try {
                log.info("{} tokens超过最大限制, 当前tokens:{}, 等待中...",
                        "seedx", tokenCounter.get());
                Thread.sleep(WAIT_INTERVAL);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
    }

    @Setter
    @Getter
    public static class SeedXCompletionRequest {

        private String model = "Seed-X";
        private String prompt;
        private Integer max_tokens = 1750;
        private Float temperature = 0.0f;
        private String[] stop = {"###", "[COT]", "[END]", "（注", "----", "---", "\n\n", "（Translation", "< < < "};
        private boolean stream = false;


        // 构造函数、getter和setter
        public SeedXCompletionRequest(String prompt) {
            this.prompt = prompt;
        }
    }

    @Getter
    @Setter
    public static class SeedXCompletionResponse {

        private String id;
        private String object;
        private long created;
        private String model;
        private List<SeedXCompletionResponse.Choice> choices;
        private SeedXCompletionResponse.Usage usage;

        @Getter
        @Setter
        public static class Choice {
            private String text;
            private int index;
            private String finish_reason;

        }

        @Getter
        @Setter
        public static class Usage {
            private int prompt_tokens;
            private int completion_tokens;
            private int total_tokens;


        }
    }

}
