-- Дедупликация загрузок по содержимому файла (§18, BUG-15): повторная загрузка того же
-- скриншота каждый раз создавала полный комплект записей и умножала портфель. SHA-256
-- содержимого позволяет узнать побайтово тот же файл и вместо повторной обработки
-- показать экран-сводку прошлой (§40.4). Похожие, но разные скриншоты по-прежнему
-- обрабатываются — вариант А из §18 относится к ним, а не к тому же самому файлу.
ALTER TABLE portfolio.uploaded_documents
  ADD COLUMN content_hash TEXT;

CREATE INDEX idx_uploaded_documents_user_content_hash
  ON portfolio.uploaded_documents (user_id, content_hash)
  WHERE content_hash IS NOT NULL;
