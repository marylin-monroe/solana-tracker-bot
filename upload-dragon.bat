@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo Dragon Files Sync Script - FINAL
echo ========================================
echo.

REM Пути с правильным экранированием для кириллицы
set "SOURCE_DIR=C:\Users\ibm\OneDrive\Документы\Dragon-main\Dragon\data\Solana\TopTraders"
set "TARGET_DIR=C:\Users\ibm\OneDrive\Документы\dragon-git\dragon-files"

echo 🔍 Исходная директория Dragon: 
echo %SOURCE_DIR%
echo.

REM Проверяем существование исходной директории
if not exist "%SOURCE_DIR%" (
    echo ❌ ОШИБКА: Директория Dragon не найдена!
    pause
    exit /b 1
)

REM Создаем целевую директорию если не существует
if not exist "%TARGET_DIR%" (
    echo 📁 Создаем целевую директорию...
    mkdir "%TARGET_DIR%" 2>nul
)

echo 📂 Целевая директория Git: 
echo %TARGET_DIR%
echo.

REM Проверяем наличие файлов Dragon
echo 🔍 Поиск файлов Dragon...
dir "%SOURCE_DIR%\*.*" >nul 2>&1
if errorlevel 1 (
    echo ⚠️  Файлы Dragon не найдены
    pause
    exit /b 0
)

echo 📋 Найденные файлы Dragon:
dir /b "%SOURCE_DIR%\*.*" 2>nul
echo.

REM Считаем количество файлов
set file_count=0
for %%f in ("%SOURCE_DIR%\*.*") do (
    set /a file_count+=1
)

echo 📊 Всего файлов: %file_count%
echo.

if %file_count% == 0 (
    echo ⚠️  Нет файлов для копирования
    pause
    exit /b 0
)

REM Очищаем старые файлы Dragon
echo 🧹 Очищаем старые файлы Dragon...
if exist "%TARGET_DIR%\allTopAddresses_*" del "%TARGET_DIR%\allTopAddresses_*" /q 2>nul
if exist "%TARGET_DIR%\topTraders_*.json" del "%TARGET_DIR%\topTraders_*.json" /q 2>nul
if exist "%TARGET_DIR%\tokens.txt" del "%TARGET_DIR%\tokens.txt" /q 2>nul

echo 📁 Копируем файлы Dragon...
copy "%SOURCE_DIR%\*.*" "%TARGET_DIR%\" /Y >nul 2>&1
if errorlevel 1 (
    echo ❌ ОШИБКА при копировании файлов!
    pause
    exit /b 1
)

echo ✅ Файлы скопированы успешно
echo.

REM Переходим в Git директорию
echo 📂 Переходим в Git директорию...
cd /d "%TARGET_DIR%"

REM Проверяем Git
echo 🔄 Проверяем Git...
git --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Git не установлен!
    pause
    exit /b 1
)

if not exist ".git" (
    echo 📁 Инициализируем Git...
    git init
    git remote add origin https://github.com/marylin-monroe/dragon-files.git
    git config user.name "marylin-monroe"
    git config user.email "korol.oleksandr.fr@gmail.com"
)

REM ИСПРАВЛЕНИЕ: Добавляем директорию в safe.directory для решения проблемы с правами
echo 🔧 Настраиваем безопасность Git...
git config --global --add safe.directory "%TARGET_DIR%"

REM ИСПРАВЛЕНО: Простое добавление файлов
echo 📝 Добавляем файлы в Git...
git add --all
if errorlevel 1 (
    echo ❌ ОШИБКА при добавлении файлов!
    pause
    exit /b 1
)

REM Проверяем есть ли изменения
git diff --cached --exit-code >nul 2>&1
if not errorlevel 1 (
    echo 📝 Нет изменений для коммита
    pause
    exit /b 0
)

REM Создаем коммит
for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set "dt=%%a"
set "YY=%dt:~2,2%" & set "YYYY=%dt:~0,4%" & set "MM=%dt:~4,2%" & set "DD=%dt:~6,2%"
set "HH=%dt:~8,2%" & set "Min=%dt:~10,2%"
set "timestamp=%DD%.%MM%.%YYYY% %HH%:%Min%"

echo 💾 Создаем коммит...
git commit -m "Dragon sync: %timestamp% (%file_count% files)"
if errorlevel 1 (
    echo ❌ ОШИБКА при создании коммита!
    pause
    exit /b 1
)

echo 🚀 Отправляем в GitHub...
git push
if errorlevel 1 (
    echo ❌ ОШИБКА при отправке!
    echo.
    echo 🔧 НУЖЕН PERSONAL ACCESS TOKEN:
    echo 1. Перейти: https://github.com/settings/tokens
    echo 2. Generate new token (classic)
    echo 3. Права: repo
    echo 4. Выполнить:
    echo    git remote set-url origin https://YOUR_TOKEN@github.com/marylin-monroe/dragon-files.git
    echo    git push
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo ✅ СИНХРОНИЗАЦИЯ ЗАВЕРШЕНА!
echo ========================================
echo 📊 Файлов обработано: %file_count%
echo ⏰ Время: %timestamp%
echo 🌐 GitHub: https://github.com/marylin-monroe/dragon-files
echo.
pause