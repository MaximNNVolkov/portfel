-- Таймаут обработки OCR-документа (§18/§34, BUG-10): если воркер забрал документ
-- (processing_status = 'processing') и упал до завершения — например, весь процесс
-- рухнул от необработанного исключения внутри tesseract.js, мимо try/catch — документ
-- навсегда остаётся в processing и блокирует очередь для всех пользователей, потому что
-- claimPendingDocument выбирает только строки со статусом pending. Нужна метка времени
-- захвата, чтобы отдельным запросом можно было находить и разблокировать зависшие строки.
ALTER TABLE portfolio.uploaded_documents
  ADD COLUMN claimed_at TIMESTAMPTZ;

CREATE INDEX idx_uploaded_documents_processing_claimed_at
  ON portfolio.uploaded_documents (claimed_at)
  WHERE processing_status = 'processing';
