const statusEl = document.getElementById('status');

async function probeWebGpu(): Promise<string> {
  if (!navigator.gpu) return 'WebGPU is not available in this browser.';
  const adapter = await navigator.gpu.requestAdapter();
  return adapter ? 'WebGPU ready.' : 'WebGPU is present but no adapter was returned.';
}

probeWebGpu().then((message) => {
  if (statusEl) statusEl.textContent = message;
});
