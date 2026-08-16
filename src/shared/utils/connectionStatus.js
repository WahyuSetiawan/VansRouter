export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

export function classifyConnectionStatus(connection) {
  const status = connection?.testStatus;
  if (
    connection?.isActive === false ||
    status === "unavailable" ||
    status === "error" ||
    status === "expired"
  ) {
    return "unavailable";
  }
  return "active";
}
