/** Safe user-facing status; never render a dependency's raw error message. */
export function sourceFailureText(report) {
  const labels = { TIMEOUT: '请求超时', NETWORK_ERROR: '网络连接失败', INVALID_DATA: '来源数据格式异常',
    DEADLINE_EXCEEDED: '已超过采集期限', INTERRUPTED_ATTEMPTS_EXHAUSTED: '采集中断且重试已耗尽' };
  const reason = labels[report.error_code] ?? (/^HTTP_\d{3}$/.test(report.error_code ?? '')
    ? '来源返回 HTTP ' + report.error_code.slice(5) : '采集未完成');
  return '采集失败（' + reason + '；已尝试 ' + (Number.isInteger(report.attempt) && report.attempt >= 0 ? report.attempt : 0) + ' 次），本期缺少该来源内容。';
}
