import { llmService } from './src/services/llm.service';

/**
 * Test script for URL analysis feature
 * Tests various types of URLs to verify LLM classification
 */
async function testUrlAnalysis() {
  console.log('🧪 Testing URL Analysis Feature\n');

  const testUrls = [
    { url: 'https://paypal.com', expected: 'safe' },
    { url: 'https://bit.ly/pay-me-now', expected: 'suspicious - shortened payment link' },
    { url: 'https://linktr.ee/scammer123', expected: 'suspicious - potential payment solicitation' },
    { url: 'https://www.temu.com/fake-deal', expected: 'suspicious - shopping scam' },
    { url: 'https://secure-instagram-login.fake.com', expected: 'phishing' },
    { url: 'https://google.com', expected: 'safe' },
    { url: 'https://venmo.com/pay/scammer', expected: 'payment solicitation' },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of testUrls) {
    try {
      console.log(`\n📍 Testing: ${test.url}`);
      console.log(`   Expected: ${test.expected}`);
      
      const result = await llmService.analyzeUrl(test.url);
      
      console.log(`   Result: ${result.isSuspicious ? '⚠️  SUSPICIOUS' : '✅ SAFE'}`);
      console.log(`   Type: ${result.linkType}`);
      console.log(`   Payment Solicitation: ${result.containsPaymentSolicitation ? 'YES' : 'NO'}`);
      console.log(`   Rationale: ${result.rationale}`);
      
      // Simple validation
      if (test.expected === 'safe' && !result.isSuspicious) {
        console.log('   ✅ PASS');
        passed++;
      } else if (test.expected !== 'safe' && result.isSuspicious) {
        console.log('   ✅ PASS');
        passed++;
      } else {
        console.log('   ❌ FAIL');
        failed++;
      }
    } catch (error) {
      console.error(`   ❌ ERROR: ${error}`);
      failed++;
    }
  }

  console.log(`\n\n📊 Test Results:`);
  console.log(`   Passed: ${passed}/${testUrls.length}`);
  console.log(`   Failed: ${failed}/${testUrls.length}`);
  console.log(`   Success Rate: ${((passed / testUrls.length) * 100).toFixed(1)}%`);

  // Test caching
  console.log(`\n\n🔄 Testing Cache:`);
  console.log('   First call (should hit LLM)...');
  const start1 = Date.now();
  await llmService.analyzeUrl('https://example.com/test');
  const time1 = Date.now() - start1;
  console.log(`   Time: ${time1}ms`);

  console.log('   Second call (should hit cache)...');
  const start2 = Date.now();
  await llmService.analyzeUrl('https://example.com/test');
  const time2 = Date.now() - start2;
  console.log(`   Time: ${time2}ms`);

  if (time2 < time1 / 2) {
    console.log('   ✅ Cache working (2nd call significantly faster)');
  } else {
    console.log('   ⚠️  Cache might not be working (2nd call not faster)');
  }

  console.log('\n✅ URL Analysis Tests Complete\n');
}

// Run tests
testUrlAnalysis()
  .then(() => {
    console.log('All tests completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });
