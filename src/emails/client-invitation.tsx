import * as React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Heading,
  Button,
  Hr,
} from '@react-email/components';

interface ClientInvitationEmailProps {
  clientName: string;
  agencyName: string;
  invitationUrl: string;
}

export const ClientInvitationEmail = ({
  clientName,
  agencyName,
  invitationUrl,
}: ClientInvitationEmailProps): React.ReactElement => {
  const previewText = `${agencyName} has invited you to Safe Replies - AI-powered comment moderation`;

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          {/* Header - Always use Safe Replies branding */}
          <Section style={header}>
            <div style={logoContainer}>
              <div style={shieldIcon}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 2L4 6V11C4 16.55 7.84 21.74 12 23C16.16 21.74 20 16.55 20 11V6L12 2Z" fill="white" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <Heading style={logoText}>Safe Replies</Heading>
            </div>
          </Section>

          {/* Main Content */}
          <Section style={content}>
            <Heading style={h1}>Welcome to Safe Replies! 👋</Heading>

            <Text style={text}>
              Hi <strong>{clientName}</strong>,
            </Text>

            <Text style={text}>
              <strong>{agencyName}</strong> has invited you to protect your social media accounts with our AI-powered comment moderation platform.
            </Text>

            {/* What you'll get section */}
            <Section style={benefitsBox}>
              <Heading style={h2}>What you'll get:</Heading>
              <Text style={benefitItem}>🛡️ Automatic deletion of blackmail, threats, and harassment</Text>
              <Text style={benefitItem}>🤖 AI-powered detection of sophisticated spam and bot networks</Text>
              <Text style={benefitItem}>⚖️ Legal-grade evidence collection for reporting</Text>
              <Text style={benefitItem}>🕵️ Bot network tracking and blocking</Text>
              <Text style={benefitItem}>📊 Real-time moderation dashboard</Text>
            </Section>

            {/* CTA Button */}
            <Section style={buttonContainer}>
              <Button style={button} href={invitationUrl}>
                Accept Invitation & Get Started
              </Button>
            </Section>

            {/* Permissions Info */}
            <Section style={infoBox}>
              <Heading style={h3}>Permissions We'll Request:</Heading>
              <Text style={smallText}>
                <strong>• Page Reading:</strong> To monitor comments on your posts in real-time
              </Text>
              <Text style={smallText}>
                <strong>• Comment Management:</strong> To automatically delete harmful comments
              </Text>
              <Text style={smallText}>
                All permissions are read-only except for comment moderation. We never post content or access private messages.
              </Text>
            </Section>

            {/* Important Note */}
            <Section style={warningBox}>
              <Text style={warningText}>
                <strong>⚠️ Important:</strong> You'll need a Facebook Business or Creator account. Personal accounts are not supported by Facebook's API.
              </Text>
            </Section>

            {/* Next Steps */}
            <Section>
              <Heading style={h3}>Next Steps:</Heading>
              <Text style={stepText}>1. Click the button above to accept the invitation</Text>
              <Text style={stepText}>2. Create your account with a secure password</Text>
              <Text style={stepText}>3. Connect your Facebook page and Instagram account</Text>
              <Text style={stepText}>4. Review your moderation settings</Text>
              <Text style={stepText}>5. Start protecting your comments automatically</Text>
            </Section>

            <Hr style={divider} />

            {/* Footer */}
            <Text style={footer}>
              This invitation was sent by <strong>{agencyName}</strong>. If you didn't expect this, you can safely ignore this email.
            </Text>

            <Text style={smallFooter}>
              Safe Replies Platform • Powered by AI • Built for Creators
              <br />
              This link expires in 7 days. Having trouble? Contact your agency for support.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

export default ClientInvitationEmail;

// Styles
const main: React.CSSProperties = {
  backgroundColor: '#fafafa',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  margin: '40px auto',
  padding: '0',
  maxWidth: '600px',
  border: '1px solid #e5e5e5',
};

const header: React.CSSProperties = {
  backgroundColor: '#000000',
  padding: '32px 24px',
  textAlign: 'center' as const,
  borderBottom: '1px solid #e5e5e5',
};

const logoContainer: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '12px',
};

const shieldIcon: React.CSSProperties = {
  width: '32px',
  height: '32px',
  backgroundColor: '#000000',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const logoText: React.CSSProperties = {
  color: '#ffffff',
  fontSize: '24px',
  fontWeight: '600',
  margin: '0',
  letterSpacing: '-0.02em',
};

const content: React.CSSProperties = {
  padding: '40px 32px',
};

const h1: React.CSSProperties = {
  color: '#0a0a0a',
  fontSize: '28px',
  fontWeight: '600',
  margin: '0 0 24px',
  lineHeight: '1.3',
  letterSpacing: '-0.02em',
};

const h2: React.CSSProperties = {
  color: '#0a0a0a',
  fontSize: '20px',
  fontWeight: '600',
  margin: '0 0 16px',
  letterSpacing: '-0.01em',
};

const h3: React.CSSProperties = {
  color: '#0a0a0a',
  fontSize: '18px',
  fontWeight: '600',
  margin: '32px 0 16px',
  letterSpacing: '-0.01em',
};

const text: React.CSSProperties = {
  color: '#525252',
  fontSize: '16px',
  lineHeight: '1.6',
  margin: '0 0 16px',
};

const benefitsBox: React.CSSProperties = {
  backgroundColor: '#fafafa',
  padding: '24px',
  border: '1px solid #e5e5e5',
  margin: '32px 0',
};

const benefitItem: React.CSSProperties = {
  color: '#404040',
  fontSize: '15px',
  lineHeight: '1.8',
  margin: '10px 0',
};

const buttonContainer: React.CSSProperties = {
  textAlign: 'center' as const,
  margin: '40px 0',
};

const button: React.CSSProperties = {
  backgroundColor: '#000000',
  color: '#ffffff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '14px 32px',
  border: '1px solid #000000',
  letterSpacing: '-0.01em',
};

const infoBox: React.CSSProperties = {
  backgroundColor: '#fafafa',
  borderLeft: '2px solid #000000',
  padding: '20px 24px',
  margin: '32px 0',
};

const warningBox: React.CSSProperties = {
  backgroundColor: '#fafafa',
  borderLeft: '2px solid #737373',
  padding: '20px 24px',
  margin: '32px 0',
};

const warningText: React.CSSProperties = {
  color: '#404040',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '0',
};

const smallText: React.CSSProperties = {
  color: '#525252',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '10px 0',
};

const stepText: React.CSSProperties = {
  color: '#525252',
  fontSize: '15px',
  lineHeight: '1.8',
  margin: '10px 0',
  paddingLeft: '5px',
};

const divider: React.CSSProperties = {
  borderColor: '#e5e5e5',
  margin: '40px 0',
};

const footer: React.CSSProperties = {
  color: '#737373',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '24px 0',
};

const smallFooter: React.CSSProperties = {
  color: '#a3a3a3',
  fontSize: '12px',
  lineHeight: '1.6',
  textAlign: 'center' as const,
  marginTop: '32px',
  paddingTop: '24px',
  borderTop: '1px solid #e5e5e5',
};
