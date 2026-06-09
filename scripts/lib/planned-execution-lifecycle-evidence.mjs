export function parseJsonObject(text) {
  if (!text || typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim().replace(/^\s*RESPONSE_MODE:\s*final\s*/iu, "").trim();
  const firstJson = trimmed.indexOf("{");
  const lastJson = trimmed.lastIndexOf("}");
  const candidate =
    firstJson >= 0 && lastJson > firstJson ? trimmed.slice(firstJson, lastJson + 1) : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function isTelegramVideoContentType(contentType) {
  const normalized = String(contentType || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
  return normalized === "video" || normalized === "messagevideo";
}

function readTelegramDelivery(payload) {
  const delivery = payload?.telegram_delivery;
  return delivery && typeof delivery === "object" ? delivery : null;
}

export function classifyStructuredTelegramDeliveryEvidence({
  parsed,
  expectedJobId,
  expectedArtifactPath,
} = {}) {
  const message = parsed?.message || parsed?.reply || null;
  const payload = parseJsonObject(message?.text);
  const delivery = readTelegramDelivery(payload);
  const jobId = typeof payload?.job_id === "string" ? payload.job_id : "";
  const artifactPath = typeof payload?.recording_path === "string" ? payload.recording_path : "";
  const messageId = delivery?.messageId ?? delivery?.message_id;
  const deliveryPath = typeof delivery?.path === "string" ? delivery.path : "";
  const checks = {
    finalJsonValid: Boolean(payload),
    statusDone: payload?.status === "done",
    jobIdPresent: Boolean(jobId),
    expectedJobId: expectedJobId ? jobId === expectedJobId : Boolean(jobId),
    artifactPathPresent: Boolean(artifactPath),
    expectedArtifactPath: expectedArtifactPath
      ? artifactPath === expectedArtifactPath
      : Boolean(artifactPath),
    deliveryOk: delivery?.ok === true,
    deliveryMessageIdPresent: Boolean(messageId),
    deliveryPathMatchesArtifact: deliveryPath ? deliveryPath === artifactPath : false,
    deliveryBoundToArtifact:
      delivery?.ok === true && !deliveryPath && !messageId && Boolean(jobId) && Boolean(artifactPath),
  };
  return {
    ok:
      checks.finalJsonValid &&
      checks.statusDone &&
      checks.expectedJobId &&
      checks.expectedArtifactPath &&
      checks.deliveryOk &&
      (checks.deliveryMessageIdPresent ||
        checks.deliveryPathMatchesArtifact ||
        checks.deliveryBoundToArtifact),
    jobId,
    artifactPath,
    delivery,
    checks,
  };
}

export function classifyTelegramPlannedExecutionEvidence(text, parsed = null, options = {}) {
  const lower = String(text ?? "").toLowerCase();
  const message = parsed?.message || parsed?.reply || null;
  const hasVideoSignal = isTelegramVideoContentType(message?.contentType);
  const deliveryEvidence = classifyStructuredTelegramDeliveryEvidence({
    parsed,
    expectedJobId: options.expectedJobId,
    expectedArtifactPath: options.expectedArtifactPath,
  });
  return {
    hasVideoSignal,
    hasDeliveryEvidence: deliveryEvidence.ok,
    deliveryEvidence,
    hasGuardrailSignal: lower.includes("guardrail") || lower.includes("tool-intent"),
    hasBlockedSignal:
      lower.includes("blocked") ||
      lower.includes("permission denied") ||
      lower.includes("can't") ||
      lower.includes("cannot") ||
      lower.includes("failed") ||
      lower.includes("卡住"),
  };
}

export function classifyMockMediaDeliveryEvidence({
  expectedJobId,
  finalJson,
  recordingResult,
  receipt,
  validation,
}) {
  const receiptPath = `/home/node/.openclaw/workspace/jobs/mock_media_deliveries/${expectedJobId}.json`;
  const checks = {
    expectedJobId: finalJson?.job_id === expectedJobId,
    mockReceiptPathOk: finalJson?.mock_delivery_receipt === receiptPath,
    receiptExists: receipt?.exists === true,
    receiptJsonValid: receipt?.jsonValid === true,
    contractOk: validation?.ok === true,
    actionOk: validation?.checks?.actionOk === true,
    mediaPathOk: validation?.checks?.mediaPathOk === true,
    mimeTypeOk: validation?.checks?.mimeTypeOk === true,
    captionOk: validation?.checks?.captionOk === true,
    validationOk: validation?.checks?.validationOk === true,
    actualVideoValid: recordingResult?.video_valid === true,
  };
  return {
    ok:
      checks.expectedJobId &&
      checks.mockReceiptPathOk &&
      checks.receiptExists &&
      checks.receiptJsonValid &&
      checks.contractOk &&
      checks.actualVideoValid,
    artifactOk: checks.receiptExists && checks.receiptJsonValid && checks.contractOk,
    receiptPath,
    checks,
  };
}
