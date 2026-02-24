package com.airtranslate.scf;

import com.airtranslate.billing.PointsInsufficientException;
import com.airtranslate.job.model.JobBilling;
import com.airtranslate.job.model.JobProgress;
import com.airtranslate.job.model.JobSpec;

import lombok.RequiredArgsConstructor;
import org.apache.commons.lang3.StringUtils;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.stereotype.Service;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.io.IOException;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class ScfClient {

    private final ScfSettings settings;

    private final RestTemplate restTemplate = buildRestTemplate();

    private static RestTemplate buildRestTemplate() {
        RestTemplate rt = new RestTemplate();
        rt.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) throws IOException {
                return false;
            }
        });
        return rt;
    }

    public String pollNextJobId() {
        String baseUrl = requiredBaseUrl();
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl).path("/worker/next").toUriString();
        ResponseEntity<Map> resp = restTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(authHeaders()), Map.class);
        if (resp.getStatusCode().value() == 204) {
            return null;
        }
        if (!resp.getStatusCode().is2xxSuccessful()) {
            return null;
        }
        Map body = resp.getBody();
        if (body == null) {
            return null;
        }
        Object jobId = body.get("jobId");
        return jobId == null ? null : String.valueOf(jobId);
    }

    public JobSpec getJobSpec(String jobId) {
        String baseUrl = requiredBaseUrl();
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl)
                .path("/worker/job")
                .queryParam("jobId", jobId)
                .toUriString();
        ResponseEntity<JobSpec> resp = restTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(authHeaders()), JobSpec.class);
        return resp.getStatusCode().is2xxSuccessful() ? resp.getBody() : null;
    }

    public JobProgress getProgress(String jobId) {
        String baseUrl = requiredBaseUrl();
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl)
                .path("/worker/progress")
                .queryParam("jobId", jobId)
                .toUriString();
        ResponseEntity<JobProgress> resp = restTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(authHeaders()), JobProgress.class);
        return resp.getStatusCode().is2xxSuccessful() ? resp.getBody() : null;
    }

    public boolean putProgress(String jobId, JobProgress progress) {
        String baseUrl = requiredBaseUrl();
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl)
                .path("/worker/progress")
                .queryParam("jobId", jobId)
                .toUriString();
        HttpEntity<JobProgress> entity = new HttpEntity<>(progress, authHeaders());
        ResponseEntity<Map> resp = restTemplate.exchange(url, HttpMethod.PUT, entity, Map.class);
        return resp.getStatusCode().is2xxSuccessful();
    }

    public JobBilling getBilling(String jobId) {
        String baseUrl = requiredBaseUrl();
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl)
                .path("/worker/billing")
                .queryParam("jobId", jobId)
                .toUriString();
        ResponseEntity<JobBilling> resp = restTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(authHeaders()), JobBilling.class);
        return resp.getStatusCode().is2xxSuccessful() ? resp.getBody() : null;
    }

    public boolean putBilling(String jobId, JobBilling billing) {
        String baseUrl = requiredBaseUrl();
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl)
                .path("/worker/billing")
                .queryParam("jobId", jobId)
                .toUriString();
        HttpEntity<JobBilling> entity = new HttpEntity<>(billing, authHeaders());
        ResponseEntity<Map> resp = restTemplate.exchange(url, HttpMethod.PUT, entity, Map.class);
        return resp.getStatusCode().is2xxSuccessful();
    }

    public String getSourceUrl(String jobId) {
        String baseUrl = requiredBaseUrl();
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl)
                .path("/worker/sourceUrl")
                .queryParam("jobId", jobId)
                .toUriString();
        ResponseEntity<Map> resp = restTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(authHeaders()), Map.class);
        if (!resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null) {
            return null;
        }
        Object u = resp.getBody().get("url");
        return u == null ? null : String.valueOf(u);
    }

    public String getResultUploadUrl(String jobId, String output) {
        String baseUrl = requiredBaseUrl();
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl)
                .path("/worker/resultUrl")
                .queryParam("jobId", jobId)
                .queryParam("output", output)
                .toUriString();
        ResponseEntity<Map> resp = restTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(authHeaders()), Map.class);
        if (!resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null) {
            return null;
        }
        Object u = resp.getBody().get("url");
        return u == null ? null : String.valueOf(u);
    }

    public String getObjectString(String cosKey) {
        String baseUrl = requiredBaseUrl();
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl)
                .path("/worker/object")
                .queryParam("cosKey", cosKey)
                .toUriString();
        ResponseEntity<Map> resp = restTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(authHeaders()), Map.class);
        if (!resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null) {
            return null;
        }
        Object content = resp.getBody().get("content");
        return content == null ? null : String.valueOf(content);
    }

    public int deductPoints(String deviceId, int delta) {
        String baseUrl = requiredBaseUrl();
        String url = UriComponentsBuilder.fromHttpUrl(baseUrl)
                .path("/worker/deduct")
                .toUriString();
        Map<String, Object> payload = Map.of("deviceId", deviceId, "delta", delta);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(payload, authHeaders());
        ResponseEntity<Map> resp = restTemplate.exchange(url, HttpMethod.POST, entity, Map.class);
        if (resp.getStatusCode().value() == 409 && resp.getBody() != null) {
            Object need = resp.getBody().get("need");
            Object balance = resp.getBody().get("balance");
            int n = need == null ? delta : Integer.parseInt(String.valueOf(need));
            int b = balance == null ? 0 : Integer.parseInt(String.valueOf(balance));
            throw new PointsInsufficientException("积分不足", n, b);
        }
        if (!resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null) {
            throw new IllegalStateException("扣费失败");
        }
        Object balance = resp.getBody().get("balance");
        return balance == null ? 0 : Integer.parseInt(String.valueOf(balance));
    }

    private String requiredBaseUrl() {
        String baseUrl = StringUtils.trimToEmpty(settings.getBaseUrl());
        if (baseUrl.isBlank()) {
            throw new IllegalStateException("scf.baseUrl未配置");
        }
        return baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        String secret = StringUtils.trimToEmpty(settings.getWorkerSecret());
        if (!secret.isBlank()) {
            headers.set("x-worker-secret", secret);
        }
        return headers;
    }
}
