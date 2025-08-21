package com.lijiahao.read.repo.mapper;

import com.lijiahao.read.entity.OfflineTranslateTemp;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;

/**
 * Book数据访问接口
 * 定义数据库操作方法
 */
@Mapper
public interface OfflineTranslateTempMapper {

    int insertSelective(OfflineTranslateTemp offlineTranslateTemp);

    OfflineTranslateTemp selectById(@Param("id") Long id);

    void updateSelective(OfflineTranslateTemp offlineTranslateTemp);

    OfflineTranslateTemp getByTranslationStatus(@Param("translationStatus") List<Integer> translationStatus);
}