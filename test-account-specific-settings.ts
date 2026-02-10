import { moderationSettingsController } from './src/controllers/moderation-settings.controller';

// Test account-specific settings functionality
async function testAccountSpecificSettings() {
  console.log('🧪 Testing account-specific moderation settings...\n');

  // Mock request/response objects
  const mockReq = {
    userId: 'test-user-id',
    clientId: null
  };

  const mockRes = {
    status: (code: number) => ({
      json: (data: any) => {
        console.log(`Response ${code}:`, JSON.stringify(data, null, 2));
        return data;
      }
    }),
    json: (data: any) => {
      console.log('Response:', JSON.stringify(data, null, 2));
      return data;
    }
  };

  try {
    // Test 1: Get settings (should return empty initially)
    console.log('📋 Test 1: Get current settings');
    await moderationSettingsController.getModerationSettings(mockReq as any, mockRes as any);

    // Test 2: Create global settings
    console.log('\n🌐 Test 2: Create global settings');
    const globalReq = {
      ...mockReq,
      body: {
        autoDeleteBlackmail: true,
        autoDeleteThreat: true,
        blackmailThreshold: 80,
        threatThreshold: 75,
        globalThreshold: 70
      }
    };
    await moderationSettingsController.updateGlobalSettings(globalReq as any, mockRes as any);

    // Test 3: Create account-specific settings
    console.log('\n👤 Test 3: Create account-specific settings');
    const accountReq = {
      ...mockReq,
      body: {
        instagramAccountId: 'test-account-id',
        autoDeleteBlackmail: false, // Different from global
        autoDeleteThreat: false,
        blackmailThreshold: 90, // Higher threshold
        threatThreshold: 85,
        globalThreshold: 70
      }
    };
    await moderationSettingsController.updateAccountSettings(accountReq as any, mockRes as any);

    // Test 4: Get settings again (should show both global and account-specific)
    console.log('\n📋 Test 4: Get settings after creating both types');
    await moderationSettingsController.getModerationSettings(mockReq as any, mockRes as any);

    console.log('\n✅ Account-specific settings test completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testAccountSpecificSettings();