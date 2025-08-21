package com.lijiahao.read.web.dto;

import lombok.Getter;
import lombok.Setter;

import java.io.Serializable;

@Setter
@Getter
public class Response<T> implements Serializable {

    private int code;

    private String message;

    private T data;

    public static <T> Response<T> success(T data){
        Response<T> response = new Response<>();
        response.setCode(200);
        response.setData(data);
        response.setMessage("success");
        return response;
    }

    public static <T> Response<T> fail(int code, String message){
        Response<T> response = new Response<>();
        response.setCode(code);
        response.setMessage(message);
        return response;
    }




}
